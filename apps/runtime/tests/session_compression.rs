//! Synthetic only: no vendor paths, credentials, external commands or live histories.
use aelys_runtime::{
    adapter::AdapterKind,
    db::LocalStore,
    discovery::{DiscoveryLimits, DiscoveryState, SessionDiscovery},
    indexing::{CandidateStatus, IndexingLimits, SessionIndexingCoordinator},
    paths::AuthorizedRoot,
};
use std::{fs, path::PathBuf};
use uuid::Uuid;

fn jsonl(text: &str) -> Vec<u8> {
    (serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant",
        "content":[{"type":"output_text","text":text}]}})
    .to_string()
        + "\n")
        .into_bytes()
}
fn zip(bytes: &[u8]) -> Vec<u8> {
    zstd::stream::encode_all(bytes, 1).unwrap()
}

#[test]
fn compressed_rollback_to_empty_clears_previous_fts() {
    let f = Fixture::new();
    let user = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"compressedquestion"}]}}).to_string();
    let original = format!(
        "{user}\n{}",
        String::from_utf8(jsonl("compressedanswer")).unwrap()
    );
    f.write("rollback.jsonl.zst", &zip(original.as_bytes()));
    assert_eq!(
        f.index(&["rollback.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::Indexed
    );
    assert_eq!(f.hits("compressedanswer"), 1);
    let rollback = serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}});
    f.write(
        "rollback.jsonl.zst",
        &zip(format!("{original}{rollback}\n").as_bytes()),
    );
    assert_eq!(
        f.index(&["rollback.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::Indexed
    );
    assert_eq!(f.hits("compressedanswer"), 0);
    assert_eq!(f.hits("compressedquestion"), 0);
}
fn limits() -> IndexingLimits {
    IndexingLimits {
        max_file_bytes: 1024,
        max_batch_bytes: 8192,
        ..Default::default()
    }
}
struct Fixture {
    dir: tempfile::TempDir,
    root: AuthorizedRoot,
    store: LocalStore,
    project: Uuid,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = AuthorizedRoot::new(dir.path()).unwrap();
        Self {
            dir,
            root,
            store: LocalStore::open_in_memory().unwrap(),
            project: Uuid::new_v4(),
        }
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.dir.path().join(name), bytes).unwrap();
    }
    fn index(
        &self,
        names: &[&str],
        lim: IndexingLimits,
    ) -> aelys_runtime::indexing::IndexingReport {
        SessionIndexingCoordinator::new(&self.store)
            .index_batch(
                &self.root,
                self.project,
                AdapterKind::CodexCli,
                &names.iter().map(PathBuf::from).collect::<Vec<_>>(),
                lim,
            )
            .unwrap()
    }
    fn hits(&self, text: &str) -> usize {
        self.store.search(text, &[self.project], 10).unwrap().len()
    }
}
#[test]
fn discovers_compound_suffix_only_when_explicit_and_indexes_local_text() {
    let f = Fixture::new();
    f.write("a.jsonl.zst", &zip(&jsonl("compressedword")));
    f.write("irrelevant.zst", b"ignore");
    let mut plain = SessionDiscovery::new(&f.root, &["jsonl"], DiscoveryLimits::default()).unwrap();
    assert!(plain.next_page().unwrap().candidates.is_empty());
    let mut walk =
        SessionDiscovery::new(&f.root, &["jsonl", "jsonl.zst"], DiscoveryLimits::default())
            .unwrap();
    let page = walk.next_page().unwrap();
    assert_eq!(page.state, DiscoveryState::Exhausted);
    assert_eq!(page.candidates, [PathBuf::from("a.jsonl.zst")]);
    let report = f.index(&["a.jsonl.zst"], limits());
    assert_eq!(report.outcomes[0].status, CandidateStatus::Indexed);
    assert_eq!(report.expanded_bytes_charged, jsonl("compressedword").len());
    assert_eq!(f.hits("compressedword"), 1);
    let session = f
        .store
        .grant_session_summaries(f.project, AdapterKind::CodexCli, None, 10)
        .unwrap();
    assert!(f
        .store
        .cloud_outbox_json(session[0].session_index_id)
        .unwrap()
        .is_none());
    // Claude discovery never opts into zst; explicit misuse also cannot decode it.
    let report = SessionIndexingCoordinator::new(&f.store)
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &[PathBuf::from("a.jsonl.zst")],
            limits(),
        )
        .unwrap();
    assert_eq!(report.outcomes[0].status, CandidateStatus::ParseRejected);
}
#[test]
fn rejects_malformed_truncated_concatenated_trailing_skippable_and_dictionary_frames() {
    let f = Fixture::new();
    let valid = zip(&jsonl("safe"));
    let mut concat = valid.clone();
    concat.extend(&valid);
    let mut trailing = valid.clone();
    trailing.push(0);
    // Standard frame declaring a dictionary ID; rejected before decoder creation.
    let dictionary = vec![0x28, 0xb5, 0x2f, 0xfd, 1, 0, 1, 1, 0, 0];
    for bytes in [
        vec![],
        b"invalid".to_vec(),
        valid[..valid.len() - 1].to_vec(),
        concat,
        trailing,
        vec![0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0],
        dictionary,
    ] {
        f.write("a.jsonl.zst", &bytes);
        let r = f.index(&["a.jsonl.zst"], limits());
        assert_eq!(r.outcomes[0].status, CandidateStatus::CompressionRejected);
        assert_eq!(r.expanded_bytes_charged, 1024);
        assert_eq!(f.hits("safe"), 0);
    }
}
#[test]
fn output_bomb_and_compressed_input_caps_preserve_previous_snapshot() {
    let f = Fixture::new();
    f.write("a.jsonl.zst", &zip(&jsonl("retained")));
    f.index(&["a.jsonl.zst"], limits());
    f.write("a.jsonl.zst", &zip(&jsonl(&"x".repeat(100_000))));
    let r = f.index(&["a.jsonl.zst"], limits());
    assert_eq!(r.outcomes[0].status, CandidateStatus::ExpandedLimitExceeded);
    assert_eq!(r.expanded_bytes_charged, 1024);
    assert_eq!(f.hits("retained"), 1);
    f.write("a.jsonl.zst", &vec![0; 1025]);
    assert_eq!(
        f.index(&["a.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::ReadRejected
    );
    let mut walk = SessionDiscovery::new(
        &f.root,
        &["jsonl.zst"],
        DiscoveryLimits {
            max_file_bytes: 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let page = walk.next_page().unwrap();
    assert_eq!(page.skipped.oversized, 1);
    assert_eq!(page.state, DiscoveryState::ExhaustedWithOmissions);
    assert_eq!(f.hits("retained"), 1);
}
#[test]
fn exact_output_cap_succeeds_and_one_byte_less_rejects() {
    let f = Fixture::new();
    let text = jsonl(&"a".repeat(300));
    let zipped = zip(&text);
    f.write("a.jsonl.zst", &zipped);
    let cap = IndexingLimits {
        max_file_bytes: text.len(),
        ..limits()
    };
    assert_eq!(
        f.index(&["a.jsonl.zst"], cap).outcomes[0].status,
        CandidateStatus::Indexed
    );
    assert_eq!(
        f.index(
            &["a.jsonl.zst"],
            IndexingLimits {
                max_file_bytes: text.len() - 1,
                ..cap
            }
        )
        .outcomes[0]
            .status,
        CandidateStatus::ExpandedLimitExceeded
    );
}
#[test]
fn large_window_is_rejected_even_when_decoded_payload_is_tiny() {
    // Standard streaming frame: no pledged size, 8 MiB window, final raw block.
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd, 0, 104];
    let text = jsonl("windowword");
    let header = ((text.len() as u32) << 3) | 1;
    frame.extend_from_slice(&header.to_le_bytes()[..3]);
    frame.extend(text);
    let f = Fixture::new();
    f.write("a.jsonl.zst", &frame);
    assert_eq!(
        f.index(&["a.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::CompressionRejected
    );
    assert_eq!(f.hits("windowword"), 0);
}
#[test]
fn small_streaming_window_without_pledged_size_still_enforces_output_cap() {
    let text = jsonl(&"x".repeat(800));
    let mut frame = vec![0x28, 0xb5, 0x2f, 0xfd, 0, 0];
    let header = ((text.len() as u32) << 3) | 1;
    frame.extend_from_slice(&header.to_le_bytes()[..3]);
    frame.extend(text);
    let f = Fixture::new();
    f.write("a.jsonl.zst", &frame);
    // Raw frame is larger than output, so choose output-limited compressed RLE frame instead.
    let r = f.index(&["a.jsonl.zst"], limits());
    assert_eq!(r.outcomes[0].status, CandidateStatus::Indexed);
    let mut bomb = vec![0x28, 0xb5, 0x2f, 0xfd, 0, 8];
    let header = (1500u32 << 3) | 3;
    bomb.extend_from_slice(&header.to_le_bytes()[..3]);
    bomb.push(b' ');
    f.write("bomb.jsonl.zst", &bomb);
    assert_eq!(
        f.index(&["bomb.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::ExpandedLimitExceeded
    );
}
#[test]
fn independent_batch_budgets_defer_unattempted_compressed_candidates() {
    let f = Fixture::new();
    let data = jsonl(&"a".repeat(400));
    f.write("a.jsonl.zst", &zip(&data));
    f.write("b.jsonl.zst", &zip(&data));
    let lim = IndexingLimits {
        max_file_bytes: 1024,
        max_batch_bytes: 1024,
        ..limits()
    };
    let r = f.index(&["a.jsonl.zst", "b.jsonl.zst"], lim);
    assert_eq!(r.outcomes.len(), 1);
    assert_eq!(r.unattempted, 1);
    assert_eq!(
        f.index(&["b.jsonl.zst"], lim).outcomes[0].status,
        CandidateStatus::Indexed
    );
}
#[test]
fn both_representations_never_allow_stale_compressed_overwrite_in_either_order() {
    for names in [["a.jsonl", "a.jsonl.zst"], ["a.jsonl.zst", "a.jsonl"]] {
        let f = Fixture::new();
        f.write("a.jsonl", &jsonl("freshword"));
        f.write("a.jsonl.zst", &zip(&jsonl("staleword")));
        let r = f.index(&names, limits());
        let conflict = names.iter().position(|name| name.ends_with("zst")).unwrap();
        assert_eq!(
            r.outcomes[conflict].status,
            CandidateStatus::RepresentationConflict
        );
        assert_eq!(f.hits("freshword"), 1);
        assert_eq!(f.hits("staleword"), 0);
        assert_eq!(
            f.index(&["a.jsonl.zst"], limits()).outcomes[0].status,
            CandidateStatus::RepresentationConflict
        );
        assert_eq!(f.hits("freshword"), 1);
    }
}
#[test]
fn compressed_then_plain_replaces_one_canonical_session_without_duplicate() {
    let f = Fixture::new();
    f.write("a.jsonl.zst", &zip(&jsonl("oldword")));
    f.index(&["a.jsonl.zst"], limits());
    f.write("a.jsonl", &jsonl("freshword"));
    f.index(&["a.jsonl"], limits());
    assert_eq!(f.hits("oldword"), 0);
    assert_eq!(f.hits("freshword"), 1);
    assert_eq!(
        f.store
            .grant_session_summaries(f.project, AdapterKind::CodexCli, None, 10)
            .unwrap()
            .len(),
        1
    );
}
#[cfg(unix)]
#[test]
fn symlink_and_parent_swaps_and_plain_symlink_conflicts_fail_closed() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    fs::write(
        outside.path().join("outside.jsonl.zst"),
        zip(&jsonl("outsideword")),
    )
    .unwrap();
    symlink(
        outside.path().join("outside.jsonl.zst"),
        f.dir.path().join("link.jsonl.zst"),
    )
    .unwrap();
    symlink(outside.path(), f.dir.path().join("parent")).unwrap();
    for name in ["link.jsonl.zst", "parent/outside.jsonl.zst"] {
        assert!(matches!(
            f.index(&[name], limits()).outcomes[0].status,
            CandidateStatus::ReadRejected | CandidateStatus::RepresentationConflict
        ));
    }
    f.write("a.jsonl.zst", &zip(&jsonl("safe")));
    symlink(outside.path().join("missing"), f.dir.path().join("a.jsonl")).unwrap();
    assert_eq!(
        f.index(&["a.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::RepresentationConflict
    );
    assert_eq!(f.hits("outsideword"), 0);
}

#[test]
fn invalid_checksum_json_and_event_limit_never_publish_partial_snapshots() {
    use std::io::Write;
    let f = Fixture::new();
    let original = jsonl("retainedword");
    f.write("a.jsonl.zst", &zip(&original));
    f.index(&["a.jsonl.zst"], limits());
    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
    encoder.include_checksum(true).unwrap();
    encoder.write_all(&jsonl("corruptedword")).unwrap();
    let mut bad = encoder.finish().unwrap();
    let last = bad.len() - 1;
    bad[last] ^= 1;
    f.write("a.jsonl.zst", &bad);
    assert_eq!(
        f.index(&["a.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::CompressionRejected
    );
    f.write("a.jsonl.zst", &zip(b"{invalid json"));
    assert_eq!(
        f.index(&["a.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::ParseRejected
    );
    let mut two = jsonl("firstword");
    two.extend(jsonl("secondword"));
    f.write("a.jsonl.zst", &zip(&two));
    assert_eq!(
        f.index(
            &["a.jsonl.zst"],
            IndexingLimits {
                max_events: 1,
                ..limits()
            }
        )
        .outcomes[0]
            .status,
        CandidateStatus::EventLimitExceeded
    );
    assert_eq!(f.hits("retainedword"), 1);
    assert_eq!(f.hits("corruptedword OR firstword OR secondword"), 0);
}
#[cfg(unix)]
#[test]
fn discovered_compressed_candidate_swapped_for_symlink_is_not_read() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    f.write("a.jsonl.zst", &zip(&jsonl("safe")));
    let page = SessionDiscovery::new(&f.root, &["jsonl.zst"], DiscoveryLimits::default())
        .unwrap()
        .next_page()
        .unwrap();
    assert_eq!(page.candidates.len(), 1);
    fs::write(
        outside.path().join("secret.zst"),
        zip(&jsonl("outsideword")),
    )
    .unwrap();
    fs::remove_file(f.dir.path().join("a.jsonl.zst")).unwrap();
    symlink(
        outside.path().join("secret.zst"),
        f.dir.path().join("a.jsonl.zst"),
    )
    .unwrap();
    let r = SessionIndexingCoordinator::new(&f.store)
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::CodexCli,
            &page.candidates,
            limits(),
        )
        .unwrap();
    assert_eq!(r.outcomes[0].status, CandidateStatus::ReadRejected);
    assert_eq!(f.hits("outsideword"), 0);
}

#[test]
fn representation_switch_between_pages_never_restores_stale_compressed_text() {
    let f = Fixture::new();
    f.write("a.jsonl", &jsonl("freshword"));
    f.write("a.jsonl.zst", &zip(&jsonl("staleword")));
    f.index(&["a.jsonl"], limits());
    fs::remove_file(f.dir.path().join("a.jsonl")).unwrap();
    assert_eq!(
        f.index(&["a.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::RepresentationConflict
    );
    assert_eq!(f.hits("freshword"), 1);
    assert_eq!(f.hits("staleword"), 0);
    // Without an earlier plain snapshot, an explicit next pass may read zst.
    let g = Fixture::new();
    g.write("a.jsonl.zst", &zip(&jsonl("compressedword")));
    g.index(&["a.jsonl.zst"], limits());
    g.write("a.jsonl", &jsonl("newplainword"));
    g.index(&["a.jsonl"], limits());
    fs::remove_file(g.dir.path().join("a.jsonl")).unwrap();
    assert_eq!(
        g.index(&["a.jsonl.zst"], limits()).outcomes[0].status,
        CandidateStatus::RepresentationConflict
    );
    assert_eq!(g.hits("newplainword"), 1);
    assert_eq!(g.hits("compressedword"), 0);
}
#[test]
fn zero_expanded_budget_allows_plain_but_defers_compressed_without_reading() {
    let f = Fixture::new();
    f.write("a.jsonl", &jsonl("plainword"));
    f.write("b.jsonl.zst", b"not read");
    let r = SessionIndexingCoordinator::new(&f.store)
        .index_batch_with_expanded_budget(
            &f.root,
            f.project,
            AdapterKind::CodexCli,
            &[PathBuf::from("a.jsonl"), PathBuf::from("b.jsonl.zst")],
            limits(),
            0,
        )
        .unwrap();
    assert_eq!(r.outcomes.len(), 1);
    assert_eq!(r.outcomes[0].status, CandidateStatus::Indexed);
    assert_eq!(r.unattempted, 1);
    assert_eq!(r.expanded_bytes_charged, 0);
    assert_eq!(f.hits("plainword"), 1);
}

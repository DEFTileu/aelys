#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::collections::BTreeSet;
use std::fs::{self, FileTimes};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use aelys_runtime::adapter::AdapterKind;
use aelys_runtime::db::LocalStore;
use aelys_runtime::discovery::{
    discover_session_files, DiscoveryCursor, DiscoveryLimits, DiscoveryState, SessionDiscovery,
};
use aelys_runtime::indexing::{CandidateStatus, IndexingLimits, SessionIndexingCoordinator};
use aelys_runtime::paths::AuthorizedRoot;
use uuid::Uuid;

fn collect(
    walk: &mut SessionDiscovery,
    limits: DiscoveryLimits,
) -> (BTreeSet<PathBuf>, DiscoveryState) {
    let mut paths = BTreeSet::new();
    for _ in 0..10_000 {
        let page = walk.next_page().unwrap();
        assert!(page.candidates.len() <= limits.max_files);
        assert!(page.entries_visited <= page.work_units);
        assert!(page.work_units <= limits.max_entries);
        for path in page.candidates {
            assert!(path.is_relative());
            assert!(paths.insert(path), "duplicate in a stable tree");
        }
        if page.state != DiscoveryState::More {
            return (paths, page.state);
        }
    }
    panic!("continuation failed to terminate");
}

#[test]
fn tiny_pages_cover_equal_epoch_and_backdated_mtimes_without_loss() {
    let dir = tempfile::tempdir().unwrap();
    let times = [
        SystemTime::UNIX_EPOCH,
        SystemTime::UNIX_EPOCH - Duration::from_secs(1),
    ];
    let mut expected = BTreeSet::new();
    for i in 0..31 {
        let name = format!("s{i:02}.JSONL");
        let file = fs::File::create(dir.path().join(&name)).unwrap();
        file.set_times(FileTimes::new().set_modified(times[i % 2]))
            .unwrap();
        expected.insert(PathBuf::from(name));
    }
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let limits = DiscoveryLimits {
        max_files: 1,
        max_entries: 2,
        ..DiscoveryLimits::default()
    };
    let mut walk = SessionDiscovery::new(&root, &["jsonl"], limits).unwrap();
    assert_eq!(
        collect(&mut walk, limits),
        (expected, DiscoveryState::Exhausted)
    );
    let end = walk.next_page().unwrap();
    assert_eq!(end.state, DiscoveryState::Exhausted);
    assert_eq!(end.work_units, 0);
}

#[test]
fn ignored_entries_and_empty_directories_consume_budget_without_false_exhaustion() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..20 {
        fs::write(dir.path().join(format!("ignored{i}.txt")), b"x").unwrap();
        fs::create_dir(dir.path().join(format!("empty{i}"))).unwrap();
    }
    fs::write(dir.path().join("target.jsonl"), b"x").unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let limits = DiscoveryLimits {
        max_entries: 1,
        ..DiscoveryLimits::default()
    };
    let mut walk = SessionDiscovery::new(&root, &["jsonl"], limits).unwrap();
    let mut seen = Vec::new();
    let mut empty_continuations = 0;
    loop {
        let page = walk.next_page().unwrap();
        assert!(page.work_units <= 1);
        if page.candidates.is_empty() && page.state == DiscoveryState::More {
            empty_continuations += 1;
        }
        seen.extend(page.candidates);
        if page.state != DiscoveryState::More {
            break;
        }
    }
    assert!(empty_continuations >= 20);
    assert_eq!(seen, [PathBuf::from("target.jsonl")]);
}

#[test]
fn size_depth_non_utf8_and_special_file_boundaries_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("exact.jsonl"), b"1234").unwrap();
    fs::write(dir.path().join("large.jsonl"), b"12345").unwrap();
    fs::create_dir(dir.path().join("nested")).unwrap();
    fs::write(dir.path().join("nested/hidden.jsonl"), b"x").unwrap();
    let invalid_name_created = match fs::write(
        dir.path()
            .join(std::ffi::OsString::from_vec(b"invalid-\xff.jsonl".to_vec())),
        b"x",
    ) {
        Ok(()) => true,
        // APFS rejects ill-formed UTF-8 before discovery can see the name.
        Err(error) if error.raw_os_error() == Some(libc::EILSEQ) => false,
        Err(error) => panic!("creating boundary fixture failed: {error}"),
    };
    let fifo = std::ffi::CString::new(dir.path().join("pipe.jsonl").as_os_str().as_encoded_bytes())
        .unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    symlink("exact.jsonl", dir.path().join("link.jsonl")).unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let mut walk = SessionDiscovery::new(
        &root,
        &["jsonl"],
        DiscoveryLimits {
            max_file_bytes: 4,
            max_depth: 0,
            ..DiscoveryLimits::default()
        },
    )
    .unwrap();
    let page = walk.next_page().unwrap();
    assert_eq!(page.candidates, [PathBuf::from("exact.jsonl")]);
    assert_eq!(page.state, DiscoveryState::ExhaustedWithOmissions);
    assert_eq!(page.skipped.oversized, 1);
    assert_eq!(page.skipped.depth_limited, 1);
    assert_eq!(page.skipped.path_limited, usize::from(invalid_name_created));
    assert_eq!(page.skipped.non_regular, 1);
    assert_eq!(page.skipped.symlinks, 1);
    assert!(!format!("{page:?}").contains("exact.jsonl"));
    assert_eq!(
        walk.next_page().unwrap().state,
        DiscoveryState::ExhaustedWithOmissions
    );
}

#[test]
fn oversized_unrelated_files_do_not_report_missing_sessions() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("session.jsonl"), b"ok").unwrap();
    fs::write(
        dir.path().join("unrelated.log"),
        b"unrelated file larger than the cap",
    )
    .unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let limits = DiscoveryLimits {
        max_file_bytes: 4,
        ..DiscoveryLimits::default()
    };
    let mut walk = SessionDiscovery::new(&root, &["jsonl"], limits).unwrap();
    let page = walk.next_page().unwrap();
    assert_eq!(page.state, DiscoveryState::Exhausted);
    assert_eq!(page.skipped.oversized, 0);
    assert_eq!(page.skipped.filtered, 1);
    assert_eq!(page.candidates, vec![PathBuf::from("session.jsonl")]);
    let mut unfiltered = SessionDiscovery::new(&root, &[], limits).unwrap();
    let page = unfiltered.next_page().unwrap();
    assert_eq!(page.state, DiscoveryState::ExhaustedWithOmissions);
    assert_eq!(page.skipped.oversized, 1);
}

#[test]
fn maximum_directory_depth_matches_coordinator_path_contract() {
    let dir = tempfile::tempdir().unwrap();
    let mut relative = PathBuf::new();
    for _ in 0..63 {
        relative.push("d");
    }
    fs::create_dir_all(dir.path().join(&relative)).unwrap();
    fs::write(dir.path().join(relative.join("accepted.jsonl")), b"x").unwrap();
    fs::create_dir(dir.path().join(relative.join("deeper"))).unwrap();
    fs::write(dir.path().join(relative.join("deeper/omitted.jsonl")), b"x").unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let limits = DiscoveryLimits {
        max_entries: 1,
        ..DiscoveryLimits::default()
    };
    let mut walk = SessionDiscovery::new(&root, &["jsonl"], limits).unwrap();
    let (found, state) = collect(&mut walk, limits);
    assert_eq!(found, BTreeSet::from([relative.join("accepted.jsonl")]));
    assert_eq!(state, DiscoveryState::ExhaustedWithOmissions);
}

#[test]
fn paused_directory_replaced_by_outside_symlink_is_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("nested")).unwrap();
    fs::write(outside.path().join("secret.jsonl"), b"secret").unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let limits = DiscoveryLimits {
        max_entries: 1,
        ..DiscoveryLimits::default()
    };
    let mut walk = SessionDiscovery::new(&root, &["jsonl"], limits).unwrap();
    let first = walk.next_page().unwrap(); // Opens nested, pauses before enumerating it.
    assert_eq!(first.state, DiscoveryState::More);
    assert!(first.candidates.is_empty());
    fs::rename(dir.path().join("nested"), outside.path().join("moved")).unwrap();
    symlink(outside.path(), dir.path().join("nested")).unwrap();
    let (found, state) = collect(&mut walk, limits);
    assert!(found.is_empty());
    assert_eq!(state, DiscoveryState::ExhaustedWithOmissions);
}

#[test]
fn replaced_root_fails_closed_at_construction_and_during_continuation() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("root");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("file.jsonl"), b"x").unwrap();
    let root = AuthorizedRoot::new(&path).unwrap();
    let mut walk = SessionDiscovery::new(
        &root,
        &["jsonl"],
        DiscoveryLimits {
            max_entries: 1,
            ..DiscoveryLimits::default()
        },
    )
    .unwrap();
    assert_eq!(walk.next_page().unwrap().state, DiscoveryState::More);
    fs::rename(&path, parent.path().join("old")).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(SessionDiscovery::new(&root, &["jsonl"], DiscoveryLimits::default()).is_err());
    assert!(walk.next_page().is_err());
    fs::remove_dir(&path).unwrap();
    fs::rename(parent.path().join("old"), &path).unwrap();
    assert!(
        walk.next_page().is_err(),
        "fatal errors invalidate continuation"
    );
}

fn claude(text: &str) -> String {
    serde_json::json!({"type":"user","message":{"role":"user","content":text}}).to_string() + "\n"
}

#[test]
fn discovered_pages_index_replay_same_mtime_rewrites_and_retry_unattempted_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let store = LocalStore::open(db.path().join("index.sqlite")).unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let project = Uuid::new_v4();
    for name in ["a.jsonl", "b.jsonl", "c.jsonl"] {
        fs::write(dir.path().join(name), claude("alpha")).unwrap();
    }
    let coordinator = SessionIndexingCoordinator::new(&store);
    for text in ["alpha", "bravo"] {
        for name in ["a.jsonl", "b.jsonl", "c.jsonl"] {
            fs::write(dir.path().join(name), claude(text)).unwrap();
            fs::File::options()
                .write(true)
                .open(dir.path().join(name))
                .unwrap()
                .set_times(FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
                .unwrap();
        }
        let mut walk = SessionDiscovery::new(
            &root,
            &["jsonl"],
            DiscoveryLimits {
                max_files: 2,
                ..DiscoveryLimits::default()
            },
        )
        .unwrap();
        loop {
            let page = walk.next_page().unwrap();
            let mut offset = 0;
            while offset < page.candidates.len() {
                let report = coordinator
                    .index_batch(
                        &root,
                        project,
                        AdapterKind::ClaudeCode,
                        &page.candidates[offset..],
                        IndexingLimits {
                            max_files: 1,
                            ..IndexingLimits::default()
                        },
                    )
                    .unwrap();
                assert_eq!(report.outcomes[0].status, CandidateStatus::Indexed);
                assert_eq!(report.unattempted, page.candidates.len() - offset - 1);
                offset += report.outcomes.len();
            }
            if page.state != DiscoveryState::More {
                break;
            }
        }
        assert_eq!(store.search(text, &[project], 10).unwrap().len(), 3);
    }
    assert!(store.search("alpha", &[project], 10).unwrap().is_empty());
    let inspect = rusqlite::Connection::open(db.path().join("index.sqlite")).unwrap();
    assert_eq!(
        inspect
            .query_row("SELECT count(*) FROM local_sync_outbox", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn file_symlink_swap_after_discovery_is_rejected_by_coordinator() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("session.jsonl"), claude("allowed")).unwrap();
    fs::write(outside.path().join("secret.jsonl"), claude("outside")).unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let page = SessionDiscovery::new(&root, &["jsonl"], DiscoveryLimits::default())
        .unwrap()
        .next_page()
        .unwrap();
    fs::remove_file(dir.path().join("session.jsonl")).unwrap();
    symlink(
        outside.path().join("secret.jsonl"),
        dir.path().join("session.jsonl"),
    )
    .unwrap();
    let db = tempfile::tempdir().unwrap();
    let store = LocalStore::open(db.path().join("index.sqlite")).unwrap();
    let report = SessionIndexingCoordinator::new(&store)
        .index_batch(
            &root,
            Uuid::new_v4(),
            AdapterKind::ClaudeCode,
            &page.candidates,
            IndexingLimits::default(),
        )
        .unwrap();
    assert_eq!(report.outcomes[0].status, CandidateStatus::ReadRejected);
}

#[test]
fn invalid_limits_are_rejected_before_traversal() {
    let dir = tempfile::tempdir().unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    for limits in [
        DiscoveryLimits {
            max_files: 0,
            ..DiscoveryLimits::default()
        },
        DiscoveryLimits {
            max_files: 1025,
            ..DiscoveryLimits::default()
        },
        DiscoveryLimits {
            max_entries: 0,
            ..DiscoveryLimits::default()
        },
        DiscoveryLimits {
            max_entries: 65_537,
            ..DiscoveryLimits::default()
        },
        DiscoveryLimits {
            max_depth: 64,
            ..DiscoveryLimits::default()
        },
        DiscoveryLimits {
            max_file_bytes: 0,
            ..DiscoveryLimits::default()
        },
        DiscoveryLimits {
            max_file_bytes: 8 * 1024 * 1024 + 1,
            ..DiscoveryLimits::default()
        },
    ] {
        assert!(SessionDiscovery::new(&root, &["jsonl"], limits).is_err());
    }
    for extensions in [vec![""], vec!["../jsonl"], vec!["jsonl"; 33]] {
        assert!(SessionDiscovery::new(&root, &extensions, DiscoveryLimits::default()).is_err());
    }
}

#[test]
fn legacy_discovery_skips_oversized_files_and_sorts_eligible_matches() {
    let dir = tempfile::tempdir().unwrap();
    for (name, content, seconds) in [
        ("large.jsonl", "12345", 4),
        ("later.jsonl", "1234", 3),
        ("earlier.JSONL", "x", 2),
    ] {
        let path = dir.path().join(name);
        fs::write(&path, content).unwrap();
        fs::File::open(path)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            )
            .unwrap();
    }
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    let roots = [(root, Uuid::new_v4(), AdapterKind::CodexCli)];
    for extensions in [&["jsonl"][..], &[][..]] {
        let found =
            discover_session_files(&roots, DiscoveryCursor::default(), extensions, 10, 4).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found[0].local_path.ends_with("earlier.JSONL"));
        assert!(found[1].local_path.ends_with("later.jsonl"));
        assert_eq!(found[1].size_bytes, 4);
    }
    fs::remove_file(dir.path().join("earlier.JSONL")).unwrap();
    fs::remove_file(dir.path().join("later.jsonl")).unwrap();
    assert!(
        discover_session_files(&roots, DiscoveryCursor::default(), &["jsonl"], 10, 4)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn legacy_discovery_caps_the_global_list_after_cursor_filtering() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let mut roots = Vec::new();
    for dir in [&first, &second] {
        for (name, seconds) in [("old.jsonl", 1), ("a.jsonl", 3), ("b.jsonl", 2)] {
            let path = dir.path().join(name);
            fs::write(&path, b"x").unwrap();
            fs::File::open(path)
                .unwrap()
                .set_times(
                    FileTimes::new()
                        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
                )
                .unwrap();
        }
        roots.push((
            AuthorizedRoot::new(dir.path()).unwrap(),
            Uuid::new_v4(),
            AdapterKind::CodexCli,
        ));
    }
    for max_files in [1, 2, 3, 4, 10] {
        let found = discover_session_files(
            &roots,
            DiscoveryCursor {
                modified_after_unix_ms: 1000,
            },
            &["jsonl"],
            max_files,
            4,
        )
        .unwrap();
        assert_eq!(found.len(), max_files.min(4));
        assert!(found
            .iter()
            .all(|item| !item.local_path.ends_with("old.jsonl")));
        assert_eq!(
            found
                .iter()
                .filter(|item| item.project_id == roots[0].1)
                .count(),
            max_files.min(2)
        );
        assert_eq!(
            found
                .iter()
                .filter(|item| item.project_id == roots[1].1)
                .count(),
            max_files.saturating_sub(2).min(2)
        );
        assert!(found
            .windows(2)
            .all(|pair| (pair[0].modified_at, &pair[0].local_path)
                <= (pair[1].modified_at, &pair[1].local_path)));
    }
}

#[test]
fn legacy_discovery_stops_before_later_roots_at_the_result_cap() {
    let first = tempfile::tempdir().unwrap();
    let later = tempfile::tempdir().unwrap();
    fs::write(first.path().join("a.jsonl"), b"x").unwrap();
    let roots = [
        (
            AuthorizedRoot::new(first.path()).unwrap(),
            Uuid::new_v4(),
            AdapterKind::CodexCli,
        ),
        (
            AuthorizedRoot::new(later.path()).unwrap(),
            Uuid::new_v4(),
            AdapterKind::CodexCli,
        ),
    ];
    later.close().unwrap();
    assert_eq!(
        discover_session_files(&roots, DiscoveryCursor::default(), &["jsonl"], 1, 1024)
            .unwrap()
            .len(),
        1
    );
    assert!(
        discover_session_files(&roots, DiscoveryCursor::default(), &["jsonl"], 0, 1024)
            .unwrap()
            .is_empty()
    );
    assert!(
        discover_session_files(&roots, DiscoveryCursor::default(), &["jsonl"], 2, 1024).is_err()
    );
}

#[test]
fn legacy_discovery_still_rejects_non_size_traversal_omissions() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("large.jsonl"), b"12345").unwrap();
    fs::write(dir.path().join("visible.jsonl"), b"x").unwrap();
    let mut nested = dir.path().to_path_buf();
    for _ in 0..64 {
        nested.push("d");
        fs::create_dir(&nested).unwrap();
    }
    fs::write(nested.join("hidden.jsonl"), b"x").unwrap();
    let root = AuthorizedRoot::new(dir.path()).unwrap();
    assert!(discover_session_files(
        &[(root, Uuid::new_v4(), AdapterKind::CodexCli)],
        DiscoveryCursor::default(),
        &["jsonl"],
        10,
        4,
    )
    .is_err());
}

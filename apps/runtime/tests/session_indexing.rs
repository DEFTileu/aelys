use std::path::{Path, PathBuf};

use aelys_runtime::adapter::AdapterKind;
use aelys_runtime::db::LocalStore;
use aelys_runtime::discovery::{ClaudeJsonlParser, CodexJsonlParser, SessionParser};
use aelys_runtime::indexing::{CandidateStatus, IndexingLimits, SessionIndexingCoordinator};
use aelys_runtime::paths::AuthorizedRoot;
use rusqlite::Connection;
use tempfile::TempDir;
use uuid::Uuid;

struct Fixture {
    directory: TempDir,
    root: AuthorizedRoot,
    store: LocalStore,
    inspect: Connection,
    project: Uuid,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalStore::open(directory.path().join("index.sqlite")).unwrap();
        let inspect = Connection::open(directory.path().join("index.sqlite")).unwrap();
        let root = AuthorizedRoot::new(directory.path()).unwrap();
        Self {
            directory,
            root,
            store,
            inspect,
            project: Uuid::new_v4(),
        }
    }

    fn write(&self, name: &str, content: &str) {
        std::fs::write(self.directory.path().join(name), content).unwrap();
    }

    fn index(
        &self,
        names: &[&str],
        adapter: AdapterKind,
        limits: IndexingLimits,
    ) -> Vec<CandidateStatus> {
        SessionIndexingCoordinator::new(&self.store)
            .index_batch(
                &self.root,
                self.project,
                adapter,
                &names.iter().map(PathBuf::from).collect::<Vec<_>>(),
                limits,
            )
            .unwrap()
            .outcomes
            .into_iter()
            .map(|o| o.status)
            .collect()
    }

    fn count(&self, table: &str) -> i64 {
        self.inspect
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn metadata(&self) -> Vec<String> {
        self.inspect
            .prepare("SELECT session_index_id || ':' || source_revision || ':' || message_count || ':' || state || ':' || COALESCE(deleted_at, '') FROM local_agent_sessions ORDER BY session_index_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
}

fn claude(text: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type": "user", "message": {"role": "user", "content": text}, "timestamp": "2026-11-05T01:00:00Z"})
    )
}

fn codex(text: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}})
    )
}

#[test]
fn codex_rollback_removes_previous_turn_from_local_search() {
    fn message(role: &str, text: &str) -> String {
        let kind = if role == "user" {
            "input_text"
        } else {
            "output_text"
        };
        format!(
            "{}\n",
            serde_json::json!({"type":"response_item","payload":{
                "type":"message","role":role,"content":[{"type":kind,"text":text}]
            }})
        )
    }
    let f = Fixture::new();
    let history = message("user", "firstquestion")
        + &message("assistant", "firstanswer")
        + &message("user", "discardquestion")
        + &message("assistant", "discardanswer");
    f.write("rollout.jsonl", &history);
    assert_eq!(
        f.index(
            &["rollout.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search("discardanswer", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    let rollback = serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}});
    f.write("rollout.jsonl", &format!("{history}{rollback}\n"));
    assert_eq!(
        f.index(
            &["rollout.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search("firstanswer", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    assert!(f
        .store
        .search("discardanswer OR discardquestion", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn codex_confirmed_rollback_to_empty_clears_stale_index() {
    let f = Fixture::new();
    let history = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"removedquestion"}]}}).to_string() + "\n" + &codex("removedanswer");
    f.write("empty.jsonl", &history);
    assert_eq!(
        f.index(
            &["empty.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    let rollback = serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}});
    f.write("empty.jsonl", &format!("{history}{rollback}\n"));
    assert_eq!(
        f.index(
            &["empty.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert!(f
        .store
        .search("removedquestion OR removedanswer", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(f.count("local_agent_messages"), 0);
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn codex_paired_events_do_not_leave_old_turns_after_repeated_rollbacks() {
    let f = Fixture::new();
    let mut rows = Vec::new();
    for question in ["firstquestion", "secondquestion", "thirdquestion"] {
        rows.push(serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":question}}).to_string());
        rows.push(serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":question}]}}).to_string());
        rows.push(codex("syntheticanswer").trim_end().to_string());
    }
    f.write("paired.jsonl", &rows.join("\n"));
    assert_eq!(
        f.index(
            &["paired.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search("firstquestion", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    for _ in 0..3 {
        rows.push(serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}).to_string());
    }
    f.write("paired.jsonl", &rows.join("\n"));
    assert_eq!(
        f.index(
            &["paired.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert!(f
        .store
        .search(
            "firstquestion OR secondquestion OR thirdquestion OR syntheticanswer",
            &[f.project],
            10
        )
        .unwrap()
        .is_empty());
}

#[test]
fn codex_context_is_not_searchable_but_user_markup_is() {
    let f = Fixture::new();
    let context = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>privatecontextfixture</environment_context>"}]}});
    let user = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Explain <section> markup: usermarkupfixture"}]}});
    f.write(
        "context.jsonl",
        &format!("{context}\n{user}\n{}", codex("responsefixture")),
    );
    assert_eq!(
        f.index(
            &["context.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert!(f
        .store
        .search("privatecontextfixture", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(
        f.store
            .search("usermarkupfixture", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn codex_context_markers_and_similar_user_text_remain_distinct_in_fts() {
    let f = Fixture::new();
    let inputs = [
        "<SKILL>fixturehiddenone</SKILL>",
        "<goal_context>fixturehiddentwo</goal_context>",
        "<codex_internal_context source=\"User\">fixturevisibleone</codex_internal_context>",
        "Another language model started to solve this problem and produced a summary of its thinking process. Please explain this fixturevisibletwo",
    ];
    let rows: Vec<_> = inputs.iter().map(|text| serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}).to_string()).collect();
    f.write("markers.jsonl", &rows.join("\n"));
    assert_eq!(
        f.index(
            &["markers.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert!(f
        .store
        .search("fixturehiddenone OR fixturehiddentwo", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(
        f.store
            .search("fixturevisibleone OR fixturevisibletwo", &[f.project], 10)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn codex_external_context_is_excluded_with_and_without_metadata() {
    let f = Fixture::new();
    let tagged = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"privatekindfixture"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["additional_content.note"]}}});
    let wrapped = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<external_note>privatemarkerfixture</external_note>"}]}});
    let ordinary = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Explain <external_note> as markup userfixture"}]}});
    f.write(
        "external.jsonl",
        &format!("{tagged}\n{wrapped}\n{ordinary}\n"),
    );
    assert_eq!(
        f.index(
            &["external.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert!(f
        .store
        .search(
            "privatekindfixture OR privatemarkerfixture",
            &[f.project],
            10
        )
        .unwrap()
        .is_empty());
    assert_eq!(
        f.store
            .search("userfixture", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn codex_compaction_preserves_visible_turns_without_indexing_replacement_history() {
    let f = Fixture::new();
    let first = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"originalquestion"}]}});
    let compacted = serde_json::json!({"type":"compacted","payload":{"message":"summaryfixture","replacement_history":[{"type":"message","role":"user","content":[{"type":"input_text","text":"replacementfixture"}]}]}});
    let data = format!(
        "{first}\n{}{compacted}\n{}",
        codex("originalanswer"),
        codex("lateranswer")
    );
    f.write("compact.jsonl", &data);
    assert_eq!(
        f.index(
            &["compact.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search(
                "originalquestion OR originalanswer OR lateranswer",
                &[f.project],
                10
            )
            .unwrap()
            .len(),
        3
    );
    assert!(f
        .store
        .search("summaryfixture OR replacementfixture", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn codex_rollback_of_image_only_turn_preserves_previous_search() {
    let f = Fixture::new();
    let first = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"keepquestionfixture"}]}});
    let image = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,fixture"}]}});
    let rollback = serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}});
    f.write(
        "image-rollback.jsonl",
        &format!(
            "{first}\n{}{image}\n{rollback}\n",
            codex("keepanswerfixture")
        ),
    );
    assert_eq!(
        f.index(
            &["image-rollback.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search("keepquestionfixture OR keepanswerfixture", &[f.project], 10)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn codex_response_before_matching_user_event_is_not_duplicated() {
    let f = Fixture::new();
    let response = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"pairquestionfixture"}]}});
    let event = serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"pairquestionfixture"}});
    f.write(
        "response-first.jsonl",
        &format!("{response}\n{event}\n{}", codex("pairanswerfixture")),
    );
    assert_eq!(
        f.index(
            &["response-first.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search("pairquestionfixture", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn codex_hook_prompt_is_not_indexed_as_user_text() {
    let f = Fixture::new();
    let hook = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<hook_prompt hook_run_id=\"hook-run-1\">hookcontextfixture</hook_prompt>"}]}});
    let user = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"realquestionfixture"}]}});
    f.write(
        "hook.jsonl",
        &format!("{hook}\n{user}\n{}", codex("realanswerfixture")),
    );
    assert_eq!(
        f.index(
            &["hook.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search("realquestionfixture", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    assert!(f
        .store
        .search("hookcontextfixture", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn codex_hook_lookalikes_remain_visible() {
    let f = Fixture::new();
    let content = [
        "<other hook_run_id=\"h\">othertagfixture</other>",
        "<hook_prompt hook_run_id=\"\">emptyidfixture</hook_prompt>",
        "About <hook_prompt hook_run_id=\"h\">quotedfixture</hook_prompt> today",
    ];
    let rows = content.iter().map(|text| serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}).to_string()).collect::<Vec<_>>().join("\n");
    f.write("lookalikes.jsonl", &rows);
    assert_eq!(
        f.index(
            &["lookalikes.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    for term in ["othertagfixture", "emptyidfixture", "quotedfixture"] {
        assert_eq!(
            f.store.search(term, &[f.project], 10).unwrap().len(),
            1,
            "{term}"
        );
    }
}

#[test]
fn codex_explicit_turn_compaction_rollback_updates_search() {
    fn event(kind: &str, turn_id: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({"type":"event_msg","payload":{"type":kind,"turn_id":turn_id}})
        )
    }
    fn user(text: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
        )
    }
    let f = Fixture::new();
    let compact = serde_json::json!({"type":"compacted","payload":{"message":"summaryfixture","replacement_history":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"replacementfixture"}]}]}});
    let rollback = serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}});
    let history = format!(
        "{}{}{}{}{}{}{}{compact}\n{}{rollback}\n{}{}{}{}",
        event("turn_started", "one"),
        user("firstquestion"),
        codex("firstanswer"),
        event("turn_complete", "one"),
        event("turn_started", "two"),
        user("discardquestion"),
        codex("discardanswer"),
        event("turn_complete", "two"),
        event("turn_started", "three"),
        user("lastquestion"),
        codex("lastanswer"),
        event("turn_complete", "three")
    );
    f.write("compact-explicit.jsonl", &history);
    assert_eq!(
        f.index(
            &["compact-explicit.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search("firstanswer OR lastanswer", &[f.project], 10)
            .unwrap()
            .len(),
        2
    );
    assert!(f
        .store
        .search(
            "discardquestion OR discardanswer OR summaryfixture OR replacementfixture",
            &[f.project],
            10
        )
        .unwrap()
        .is_empty());
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn codex_compaction_with_rollback_preserves_previous_snapshot() {
    let f = Fixture::new();
    let original = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"preservedquestion"}]}});
    let history = format!("{original}\n{}", codex("preservedanswer"));
    f.write("compact-rollback.jsonl", &history);
    assert_eq!(
        f.index(
            &["compact-rollback.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    let before = f.metadata();
    let compacted = serde_json::json!({"type":"compacted","payload":{"message":"syntheticsummary","replacement_history":[]}});
    let rollback = serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}});
    f.write(
        "compact-rollback.jsonl",
        &format!("{history}{compacted}\n{rollback}\n"),
    );
    assert_eq!(
        f.index(
            &["compact-rollback.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::ParseRejected]
    );
    assert_eq!(f.metadata(), before);
    assert_eq!(
        f.store
            .search("preservedanswer", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    assert!(f
        .store
        .search("syntheticsummary", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn codex_rollback_followed_by_corruption_preserves_previous_snapshot() {
    let f = Fixture::new();
    let history = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"keptquestion"}]}}).to_string() + "\n" + &codex("keptanswer");
    f.write("corrupt.jsonl", &history);
    assert_eq!(
        f.index(
            &["corrupt.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    let before = f.metadata();
    let rollback = serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}});
    f.write("corrupt.jsonl", &format!("{history}{rollback}\n{{broken"));
    assert_eq!(
        f.index(
            &["corrupt.jsonl"],
            AdapterKind::CodexCli,
            IndexingLimits::default()
        ),
        [CandidateStatus::ParseRejected]
    );
    assert_eq!(f.metadata(), before);
    assert_eq!(
        f.store
            .search("keptanswer", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn both_adapters_replay_and_rewrites_replace_local_snapshots_only() {
    let f = Fixture::new();
    f.write("claude.jsonl", &(claude("alpha") + &claude("obsolete")));
    f.write("codex.jsonl", &codex("beta"));
    for _ in 0..2 {
        assert_eq!(
            f.index(
                &["claude.jsonl"],
                AdapterKind::ClaudeCode,
                IndexingLimits::default()
            ),
            [CandidateStatus::Indexed]
        );
        assert_eq!(
            f.index(
                &["codex.jsonl"],
                AdapterKind::CodexCli,
                IndexingLimits::default()
            ),
            [CandidateStatus::Indexed]
        );
    }
    assert_eq!(f.count("local_agent_sessions"), 2);
    assert_eq!(f.count("local_agent_messages"), 3);
    assert_eq!(f.count("local_agent_messages_fts"), 3);
    let hits = f.store.search("alpha OR beta", &[f.project], 10).unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits
        .iter()
        .all(|h| h.source_ref == format!("{}:{}", h.session_id, h.seq)));
    assert!(f
        .store
        .search("alpha", &[Uuid::new_v4()], 10)
        .unwrap()
        .is_empty());

    f.write("claude.jsonl", &claude("replacement"));
    f.index(
        &["claude.jsonl"],
        AdapterKind::ClaudeCode,
        IndexingLimits::default(),
    );
    assert!(f
        .store
        .search("alpha OR obsolete", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(
        f.store
            .search("replacement", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.count("local_agent_messages"), 2);
    assert_eq!(f.count("local_sync_outbox"), 0);
    let paths: i64 = f.inspect.query_row("SELECT COUNT(*) FROM local_agent_sessions WHERE local_session_ref LIKE '%jsonl' AND native_session_id='' AND state='indexed'", [], |r| r.get(0)).unwrap();
    assert_eq!(paths, 2);
}

#[test]
fn claude_branch_replacement_removes_discarded_text_from_search() {
    let f = Fixture::new();
    let root = r#"{"type":"user","uuid":"u","parentUuid":null,"message":{"role":"user","content":"rootword"}}"#;
    let old = r#"{"type":"assistant","uuid":"old","parentUuid":"u","message":{"role":"assistant","content":"discardedword"}}"#;
    let new = r#"{"type":"assistant","uuid":"new","parentUuid":"u","message":{"role":"assistant","content":"currentword"}}"#;
    f.write("branch.jsonl", &format!("{root}\n{old}\n"));
    assert_eq!(
        f.index(
            &["branch.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert_eq!(
        f.store
            .search("discardedword", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    f.write("branch.jsonl", &format!("{root}\n{old}\n{new}\n"));
    assert_eq!(
        f.index(
            &["branch.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    assert!(f
        .store
        .search("discardedword", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(
        f.store
            .search("currentword", &[f.project], 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn claude_recovered_response_order_survives_indexing() {
    let f = Fixture::new();
    let records = [
        serde_json::json!({"type":"user","uuid":"u","parentUuid":null,"message":{"role":"user","content":"root"}}),
        serde_json::json!({"type":"assistant","uuid":"a","parentUuid":"u","message":{"id":"response","role":"assistant","content":"first"}}),
        serde_json::json!({"type":"assistant","uuid":"b","parentUuid":"a","timestamp":"2026-01-01T10:00:00Z","message":{"id":"response","role":"assistant","content":"later"}}),
        serde_json::json!({"type":"assistant","uuid":"c","parentUuid":"a","timestamp":"2026-01-01T09:00:00Z","message":{"id":"response","role":"assistant","content":"earlier"}}),
        serde_json::json!({"type":"user","uuid":"next","parentUuid":"a","message":{"role":"user","content":"next"}}),
    ];
    f.write(
        "order.jsonl",
        &records
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    );
    assert_eq!(
        f.index(
            &["order.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed]
    );
    let contents = f
        .inspect
        .prepare("SELECT content FROM local_agent_messages ORDER BY seq")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(contents, ["root", "first", "earlier", "later", "next"]);
}

#[test]
fn failures_empty_files_and_missing_candidates_preserve_previous_snapshots() {
    let f = Fixture::new();
    f.write("session.jsonl", &claude("retained"));
    f.index(
        &["session.jsonl"],
        AdapterKind::ClaudeCode,
        IndexingLimits::default(),
    );
    let before = f.metadata();
    for content in [
        claude("partial") + "{\"type\":",
        String::new(),
        "{\"type\":\"unknown_vendor_envelope\"}\n".into(),
    ] {
        f.write("session.jsonl", &content);
        let statuses = f.index(
            &["session.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits::default(),
        );
        assert!(matches!(
            statuses[0],
            CandidateStatus::ParseRejected | CandidateStatus::EmptySnapshot
        ));
        assert_eq!(f.metadata(), before);
        assert_eq!(
            f.store.search("retained", &[f.project], 10).unwrap().len(),
            1
        );
        assert!(f
            .store
            .search("partial", &[f.project], 10)
            .unwrap()
            .is_empty());
    }
    std::fs::remove_file(f.directory.path().join("session.jsonl")).unwrap();
    assert_eq!(
        f.index(
            &["session.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits::default()
        ),
        [CandidateStatus::ReadRejected]
    );
    assert_eq!(f.metadata(), before);
    assert_eq!(
        f.store.search("retained", &[f.project], 10).unwrap().len(),
        1
    );
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn complete_jsonl_without_final_newline_is_indexed_for_both_adapters() {
    for (adapter, complete) in [
        (AdapterKind::ClaudeCode, claude as fn(&str) -> String),
        (AdapterKind::CodexCli, codex as fn(&str) -> String),
    ] {
        let f = Fixture::new();
        f.write("session.jsonl", &complete("previous"));
        assert_eq!(
            f.index(&["session.jsonl"], adapter, IndexingLimits::default()),
            [CandidateStatus::Indexed]
        );
        let complete = complete("newcontent");
        f.write("session.jsonl", complete.trim_end_matches('\n'));
        assert_eq!(
            f.index(&["session.jsonl"], adapter, IndexingLimits::default()),
            [CandidateStatus::Indexed]
        );
        assert_eq!(
            f.store
                .search("newcontent", &[f.project], 10)
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn store_failure_rolls_back_metadata_messages_and_fts_then_continues_batch() {
    let f = Fixture::new();
    f.write("session.jsonl", &claude("original"));
    f.index(
        &["session.jsonl"],
        AdapterKind::ClaudeCode,
        IndexingLimits::default(),
    );
    let before = f.metadata();
    // Fails after metadata update and snapshot deletion, inside the real store
    // transaction. The coordinator must not publish a half-updated revision.
    f.inspect.execute_batch("CREATE TRIGGER reject_snapshot BEFORE INSERT ON local_agent_messages WHEN NEW.content='rejected' BEGIN SELECT RAISE(ABORT, 'test snapshot failure'); END;").unwrap();
    f.write("session.jsonl", &claude("rejected"));
    f.write("next.jsonl", &claude("accepted"));
    assert_eq!(
        f.index(
            &["session.jsonl", "next.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits::default()
        ),
        [CandidateStatus::StoreRejected, CandidateStatus::Indexed]
    );
    assert!(f.metadata().contains(&before[0]));
    assert_eq!(
        f.store
            .search("original OR accepted", &[f.project], 10)
            .unwrap()
            .len(),
        2
    );
    assert!(f
        .store
        .search("rejected", &[f.project], 10)
        .unwrap()
        .is_empty());
    assert_eq!(f.count("local_agent_messages"), 2);
    assert_eq!(f.count("local_agent_messages_fts"), 2);
    assert_eq!(f.count("local_sync_outbox"), 0);
}

#[test]
fn file_event_and_byte_limits_never_store_partial_snapshots_or_infer_deletions() {
    let f = Fixture::new();
    let content = claude("first");
    f.write("first.jsonl", &content);
    f.write("second.jsonl", &claude("second"));
    let candidates = [PathBuf::from("first.jsonl"), PathBuf::from("second.jsonl")];
    let coordinator = SessionIndexingCoordinator::new(&f.store);
    let report = coordinator
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &candidates,
            IndexingLimits {
                max_files: 1,
                ..IndexingLimits::default()
            },
        )
        .unwrap();
    assert_eq!(report.outcomes.len(), 1);
    assert_eq!(report.unattempted, 1);
    assert_eq!(f.count("local_agent_sessions"), 1);

    let report = coordinator
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &candidates,
            IndexingLimits {
                max_batch_bytes: content.len(),
                max_file_bytes: content.len(),
                ..IndexingLimits::default()
            },
        )
        .unwrap();
    assert_eq!(report.bytes_charged, content.len());
    assert_eq!(report.unattempted, 1);
    assert_eq!(report.outcomes[0].status, CandidateStatus::Indexed);
    let before = f.metadata();
    f.write("first.jsonl", &(claude("newer") + &claude("extra")));
    assert_eq!(
        f.index(
            &["first.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits {
                max_events: 1,
                ..IndexingLimits::default()
            }
        ),
        [CandidateStatus::EventLimitExceeded]
    );
    assert_eq!(f.metadata(), before);
    assert_eq!(
        f.index(
            &["first.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits {
                max_file_bytes: 8,
                ..IndexingLimits::default()
            }
        ),
        [CandidateStatus::ReadRejected]
    );
    assert_eq!(f.metadata(), before);
    assert_eq!(f.store.search("first", &[f.project], 10).unwrap().len(), 1);

    let report = coordinator
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &candidates[1..],
            IndexingLimits::default(),
        )
        .unwrap();
    assert_eq!(report.unattempted, 0);
    assert_eq!(f.count("local_agent_sessions"), 2);
    // Processing an empty explicit batch proves nothing about filesystem deletions.
    coordinator
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &[],
            IndexingLimits::default(),
        )
        .unwrap();
    assert_eq!(
        f.store
            .search("first OR second", &[f.project], 10)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn valid_file_that_exceeds_remaining_event_budget_is_deferred() {
    let f = Fixture::new();
    f.write("first.jsonl", &(claude("first") + &claude("second")));
    f.write("next.jsonl", &(claude("third") + &claude("fourth")));
    let coordinator = SessionIndexingCoordinator::new(&f.store);
    let candidates = [PathBuf::from("first.jsonl"), PathBuf::from("next.jsonl")];
    let limits = IndexingLimits {
        max_events: 3,
        ..IndexingLimits::default()
    };
    let page = coordinator
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &candidates,
            limits,
        )
        .unwrap();
    assert_eq!(page.outcomes.len(), 1);
    assert_eq!(page.outcomes[0].status, CandidateStatus::Indexed);
    assert_eq!(page.unattempted, 1);
    let next = coordinator
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &candidates[1..],
            limits,
        )
        .unwrap();
    assert_eq!(next.outcomes[0].status, CandidateStatus::Indexed);
    assert_eq!(f.store.search("third", &[f.project], 10).unwrap().len(), 1);
}

#[test]
fn valid_file_is_deferred_when_previous_reads_reduce_byte_allowance() {
    let f = Fixture::new();
    f.write("first.jsonl", &claude("first"));
    f.write("next.jsonl", &claude(&"x".repeat(80)));
    let coordinator = SessionIndexingCoordinator::new(&f.store);
    let candidates = [PathBuf::from("first.jsonl"), PathBuf::from("next.jsonl")];
    let limits = IndexingLimits {
        max_file_bytes: 256,
        max_batch_bytes: 256,
        ..IndexingLimits::default()
    };
    let first = coordinator
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &candidates,
            limits,
        )
        .unwrap();
    assert_eq!(first.outcomes.len(), 1);
    assert_eq!(first.outcomes[0].status, CandidateStatus::Indexed);
    assert_eq!(first.unattempted, 1);
    let second = coordinator
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::ClaudeCode,
            &candidates[1..],
            limits,
        )
        .unwrap();
    assert_eq!(second.outcomes[0].status, CandidateStatus::Indexed);
    assert_eq!(f.count("local_agent_sessions"), 2);
}

#[test]
fn failed_reads_are_charged_and_reports_do_not_expose_paths_or_content() {
    let f = Fixture::new();
    let candidates = [
        PathBuf::from("private-missing.jsonl"),
        PathBuf::from("next.jsonl"),
    ];
    let report = SessionIndexingCoordinator::new(&f.store)
        .index_batch(
            &f.root,
            f.project,
            AdapterKind::CodexCli,
            &candidates,
            IndexingLimits {
                max_file_bytes: 10,
                max_batch_bytes: 10,
                ..IndexingLimits::default()
            },
        )
        .unwrap();
    assert_eq!(report.bytes_charged, 10);
    assert_eq!(report.unattempted, 1);
    assert!(!format!("{report:?}").contains("private-missing"));
    assert_eq!(f.count("local_agent_sessions"), 0);
}

#[test]
fn binding_and_path_validation_reject_escapes_before_any_writes() {
    let f = Fixture::new();
    let coordinator = SessionIndexingCoordinator::new(&f.store);
    assert!(coordinator
        .index_batch(
            &f.root,
            Uuid::nil(),
            AdapterKind::ClaudeCode,
            &[],
            IndexingLimits::default()
        )
        .is_err());
    for limits in [
        IndexingLimits {
            max_files: 0,
            ..IndexingLimits::default()
        },
        IndexingLimits {
            max_file_bytes: usize::MAX,
            ..IndexingLimits::default()
        },
        IndexingLimits {
            max_batch_bytes: 0,
            ..IndexingLimits::default()
        },
        IndexingLimits {
            max_events: 0,
            ..IndexingLimits::default()
        },
    ] {
        assert!(coordinator
            .index_batch(&f.root, f.project, AdapterKind::ClaudeCode, &[], limits)
            .is_err());
    }
    assert_eq!(
        f.index(
            &["../outside.jsonl", "/tmp/outside.jsonl", ""],
            AdapterKind::ClaudeCode,
            IndexingLimits::default()
        ),
        [CandidateStatus::ReadRejected; 3]
    );
    assert_eq!(f.count("local_agent_sessions"), 0);
}

#[cfg(unix)]
#[test]
fn descriptor_read_rejects_symlinked_files_and_parent_directories() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(
        outside.path().join("secret.jsonl"),
        claude("privateoutside"),
    )
    .unwrap();
    symlink(
        outside.path().join("secret.jsonl"),
        f.directory.path().join("leaf.jsonl"),
    )
    .unwrap();
    symlink(outside.path(), f.directory.path().join("parent")).unwrap();
    assert_eq!(
        f.index(
            &["leaf.jsonl", "parent/secret.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits::default()
        ),
        [CandidateStatus::ReadRejected; 2]
    );
    assert_eq!(f.count("local_agent_sessions"), 0);
    assert!(f
        .store
        .search("privateoutside", &[f.project], 10)
        .unwrap()
        .is_empty());
}

#[test]
fn equivalent_relative_spellings_have_one_identity() {
    let f = Fixture::new();
    std::fs::create_dir(f.directory.path().join("nested")).unwrap();
    f.write("nested/session.jsonl", &claude("sameidentity"));
    assert_eq!(
        f.index(
            &["nested/session.jsonl", "nested/./session.jsonl"],
            AdapterKind::ClaudeCode,
            IndexingLimits::default()
        ),
        [CandidateStatus::Indexed; 2]
    );
    assert_eq!(f.count("local_agent_sessions"), 1);
    assert_eq!(f.count("local_agent_messages_fts"), 1);
}

#[test]
fn byte_parsers_fail_closed_without_reopening_paths_or_accepting_partial_json() {
    for (parser, valid) in [
        (&ClaudeJsonlParser as &dyn SessionParser, claude("safe")),
        (&CodexJsonlParser as &dyn SessionParser, codex("safe")),
    ] {
        assert_eq!(
            parser.parse_snapshot_bytes(valid.as_bytes(), 1).unwrap()[0].content,
            "safe"
        );
        assert!(parser
            .parse_snapshot_bytes(&(valid.clone() + "{broken").into_bytes(), 10)
            .is_err());
        assert!(parser.parse_snapshot_bytes(&[0xff], 10).is_err());
        assert!(parser
            .parse_snapshot_bytes((valid.clone() + &valid).as_bytes(), 1)
            .is_err());
    }
    struct LegacyOnly;
    impl SessionParser for LegacyOnly {
        fn parse_increment(
            &self,
            _: &Path,
            _: u64,
        ) -> aelys_runtime::RuntimeResult<Vec<aelys_runtime::discovery::SessionEvent>> {
            panic!("byte parsing must never delegate to a path reader")
        }
    }
    assert!(LegacyOnly
        .parse_snapshot_bytes(claude("safe").as_bytes(), 1)
        .is_err());
}

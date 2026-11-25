# Pending branch consolidation — 2026-11-25

Owner explicitly requested merging all remaining committed branches into main.
Base: d64d5075c880a08dde0beffd24384231905db06a. Implementation:
f688d8bebe0288737e057723aabff1858ba26403. All 23 requested branch heads are
ancestors of the implementation commit. Two additional already-merged Telegram
refs were frozen for reference. Uncommitted work in other worktrees was excluded.

## Release limits

Integration does not complete every experimental module. ADR-031 OTA remains
PROPOSED; device-side update/signing acceptance is incomplete. The action journal
reconciles outcomes in a running session; persistence/recovery after reboot is
still a prerequisite. No physical device/provider acceptance, firmware flash,
or installed macOS rebuild was performed for this consolidation.

## Validation

Implementer recorded full backend: 2129 passed, 193 skipped; web: 1062 passed;
shared: 84 passed; native transport: 123 passed, 2 ignored; desktop Rust: 32 passed;
firmware host: 69/69 passed; ESP-IDF build: 1862544 bytes, below 2 MiB.
CI Ruff/mypy, typechecks, frontend build and desktop cargo check passed.
Full repository Ruff has 23 pre-existing migration/script findings. Opt-in
PostgreSQL/hardware/credential-dependent tests remain skipped.

Final parent validation: all frozen references independently verified as ancestors;
`git diff --check` passed; existing main migrations unchanged, only 0066 added;
`uv run --frozen --extra test pytest -q tests/test_clean_migrations.py tests/test_companion_firmware_migration.py tests/test_focus_service_chat_migration.py tests/test_ai_voice.py`
from backend: 26 passed, 2 skipped in 11.58s. Pytest asyncio fixture scope warning.

## Frozen references

```text
claude/strange-bose-4883d6 d18b162b993792b8b59b3e2d8caa9156a66f66b2
codex/ai-chat-voice a012606e1e17d240942927eaeecdee36399e90aa
codex/answer-trace-history 4036fd4da17dd76469c35ee35bd455b05eb79a51
codex/companion-action-journal 29da4956ab36c2457f2cf1b38e6f3d979be878ea
codex/companion-focus-layout f68217c5ad54defa0327695f2857d868f8d73b2e
codex/companion-menu-only c2983e926af762421ac330b37e2f494832e678b1
codex/companion-offline-contacts-now 22d80303677e0c9528d9710c64c503bcb4185d89
codex/companion-ota-sync 8b3458f98bfb227695d0eb2d55e5fd0447375d76
codex/companion-screen-latency 85b603d2af4db1ab1a933aca1ba52d71ae85906d
codex/companion-side-keys 0374d08a2ffaf912f25f527064ba6da43908efeb
codex/companion-steady-link 45e44bc62f9db7e657d7c8020da531267591706e
codex/companion-voice-clear 1c8879cfab21d2d46bfe7c218644a598645cc215
codex/companion-weather-design 311254fa4a29b92412d6618c19ff6e4ce35b2208
codex/mcp-knowledge a71ceb47a3189da2924ae2584f5af116850d668e
codex/telegram-answer-layout 2b7e6a18e88cda4e70423e40074636894a41b581
codex/telegram-answer-presentation 363390fb5a0b472912a4face3e0fa3870e2d9055
codex/telegram-guest-mode f0447286fc40eb6c7b7ae312160ed4c280bf5fb3
feat/ai-feature-defaults 8cf82676f03598411027740cb34867972d189629
feat/companion-angry-bigger 0c0c2685f997ef811a9f39213d4ce0af754edd5a
feat/companion-ota-power 1c69b5eafaa205222b59bdb576a240710494cf58
feat/focus-page 455a05d650b50873eb38651cab352921347e0558
feat/focus-planned-length 19d098de29b923dbdf1667870168ed7d8ed36a41
feat/live-change-hints 3783f7b6769003ef8f04b2358458d93c9f802f39
fix/home-focus-countdown 87255cdd778ec540776824ccf5b50f43d241f19e
perf/companion-internal-ram 47e45e16da3a7382ff682023e959ac4457dff8eb
```

## Integration log (chronological)

```text
Base origin/main d64d5075c880a08dde0beffd24384231905db06a; frozen refs /tmp/aelys-integration-frozen-refs.txt. No OPEN/PROPOSED decisions promoted. No live provider or Telegram calls.
Merge commits: 8d26dfe voice chat; b930cfe scoped MCP knowledge; d8a2999 Telegram history; 4bc0fb2 system status from focus-page; 2de8529 home countdown history; cbc41d7 AI defaults history; bda675c change hints history; 061aabe focus planned duration; 0ab8e0b guest history.
Voice chat: kept clipboard success/error reporting and Telegram CSP; microphone self, voice no-store. AI defaults: older branch conflicts discarded individually because newer focus/voice options, one_shot policy, companion security and web-search already in main. Focus-page: retained newer app-limits route, Ask Aelys UI, simulator navigation and published side-key notes; retained status endpoint no-store. Live hints already in main, preserved newer API contract sections. Focus length: main migration 0063 supersedes old 0061, old file removed; normalize default before idempotency check; snapshot duration conveyed to companion. Guest branch: retained newer guest untrusted-text enforcement, cancellation, presentation and sanitized logging; excluded full exception tracebacks which can include sensitive data.
Evidence: voice backend 58 passed; web 39 passed and typecheck; MCP native cargo 114 passed 2 ignored; Telegram history 62 passed; status backend 6 web 5; notes drafts 18; defaults backend 1 web 10; change hints web 6; focus backend 42 web 17 typecheck, direct C proto test exit 0; Alembic head 0065. Web whole suite first run 1056 passed 1 failed device-auth timing, isolated rerun 10 passed.
In progress: merge claude/strange-bose-4883d6 conflicts. Its older PWR shutdown inhibition conflicts with current low-key voice; current control deliberately preserves normal PMIC poweroff. Includes extra staged obsolete voice_power header/test and board API that must be evaluated with conflicts. No decision recorded for unresolved conflicts. LVGL clone for simulator running, no result yet. Remaining firmware and action-journal branches not integrated. Full validation not done.
Additional merges: fabd56f old companion voice history; 808b07d voice clarity history; 2efec1a Focus layout; 7d4f530 menu; 57913a3 side keys; 4ee68c7 offline contacts; 6d04e40 weather; 147a891 character; ccfba67 PSRAM; 14fa16d steady link; 0afe858 display metrics; 9a73352 proposed OTA service; 9a4aa42 action receipts.
Voice resolution by area: backend chat_support/turn preserve Telegram presentation and search history; voice/provider retain newer language and per-request budget/ephemeral audio; board_audio retains buffering/volume; board_input, ui hooks/screens and app_main retain lower-key voice and normal PWR behavior, deleting obsolete power suppression code; link/proto retain voice_heard, metering and cancel fencing; tests and docs retain newer behavior. Focus layout kept current durable game state/voice screenshots. Menu kept current motion shake thresholds, tests, and Ask navigation. Side-key publication notes retained. Character retains newer context-specific sounds and screens. Screen latency keeps DMA ownership safety, current face/character/sound, and introduces measured display I/O instrumentation; old duplicate growl/poke implementation discarded. Steady link combines token renewal and lookup support; avoids stale-validation close after renewal. OTA migration 0066 follows unchanged main migrations, only two new tables; OTA ADR renumbered 031 and remains PROPOSED. Journal combines ordered lookup with voice writer and current UI, uses UUID correlated optimistic outcomes, no automatic NVS erase. Journal codec/NVS adapter remains standalone prerequisite with recovery policy explicitly open; do not claim durable replay across reboot.
Checks after journal: pytest action lookup/channel/e2e/voice 73 passed 5 skipped; ctest 69/69 after correcting boot gate host harness. OTA pytest 74 passed 2 skipped PostgreSQL; native transport cargo test 123 passed 2 ignored; Alembic 0066 single head. Full web 1062 passed; shared 84 passed; shared+web typecheck and web build passed (Vite chunk warning). Full Ruff 23 preexisting migration import/shebang findings; changed 40 Python files Ruff passed. All 23 requested refs ancestor proof /tmp/aelys-ancestor-proof.txt.
Final HEAD f688d8bebe0288737e057723aabff1858ba26403; 23/23 specified frozen refs ancestor, /tmp/aelys-ancestor-proof.txt; clean tracked tree, no push. Last docs commit fixes ADR reference only. Full backend: uv run --frozen --extra test pytest -q = 2129 passed, 193 skipped, one Starlette deprecation, 425s. pnpm web test 1062 passed; shared test 84 passed, shared and web typecheck, pnpm build pass (Vite chunk warning). CI ruff backend/app backend/tests pass; mypy 156 source files pass; scripts ruff+mypy and pytest 19 pass. Full backend ruff check . has 23 existing findings in alembic/env.py, versions 0002–0022 and scripts/generate_runtime_manifest.py. cargo test native transport 123 passed 2 ignored; cargo check desktop pass; desktop cargo test --lib 32 passed. Host ctest 69/69 passed; ESP-IDF 6.1 idf.py build passed with example contacts, bin 1,862,544 bytes (<2MiB). No flash or real device/provider acceptance. PostgreSQL tests and other opt-in tests among 193 skips require separate disposable service/credentials. Alembic head 0066. Owner-approved main fixes present: 0065 focus service chats; AI guest job origin filtering; in-app project/notes DeleteConfirm desktop/mobile; clipboard success/failure. Proposal ADR-031 remains PROPOSED; OTA board integration/signing and action journal reboot durability remain incomplete prerequisites, not complete modules.
```

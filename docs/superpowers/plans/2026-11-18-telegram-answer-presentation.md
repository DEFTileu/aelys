# Telegram answer presentation

Scope: IMPLEMENTATION_PLAN Phase 4, AI Core search/provenance. Owner requested
readable Markdown, a labelled trace link and sources in Mini App, plus investigation
of slow opening. Branch derives from released part 1 plus command error diagnostics;
part 2 history changes remain excluded.

## Execution

GPT-6.2 Sol implemented Python delivery and tests. GPT-6.1 Sol implemented static
startup handling and tests, then reviewed delivery. Parent integrated and validated.
No migration or infrastructure changes. Deployment remains an owner decision.

## Result

Personal AI replies render a bounded Markdown subset through Telegram entities:
bold, italic, inline/fenced code, lists and labelled public HTTP(S) links. Offsets and
chunks use UTF-16. Raw HTML remains literal, unsupported markup stays text. The
footer is a text link named «Как я ответил». Ordinary non-AI notices are unchanged.
Very long whitespace-only gaps are shortened to fit a nonempty Telegram message;
code indentation and nonblank content are retained. This is not full CommonMark.

Telegram tool turns no longer append an automatic source list. The Telegram prompt
also asks the model to omit bibliography/citation links, while preserving links
explicitly requested by the owner. This instruction is model-dependent; arbitrary
model text is not heuristically deleted. Trace events still retain sources and the
protected endpoint returns them; Web tool turns keep their original source appendix.

The official Telegram SDK loads asynchronously so local loading/error logic can run.
SDK wait is bounded to 15 seconds with retry; initData authentication and credential
cleanup remain unchanged. This improves error handling, not DNS or transfer speed.
From the local Mac, Railway DNS resolution timed out on repeated 8–15s requests,
while the official SDK fetched in 0.63s. No phone latency measurement establishes a
root cause there, and this change does not claim to eliminate that network delay.

## Verification

- Telegram formatter/delivery/dialogue/trace/transport/sources/command errors:
  157 passed, no skips.
- Shared/streamed AI tool turn: 11 passed, 1 skipped (opt-in PostgreSQL); skip is
  not success and PostgreSQL validation is not claimed for this change.
- Browser UI with installed Chrome and official SDK: 21 passed, zero skips.
  Controlled delayed SDK and failed SDK cases, auth, sources and accessibility.
- Ruff on modified Python files and git diff --check: passed.
- Mypy with current environment: 63 errors, same errors as released 32054d51 after
  normalizing shifted line numbers; no new errors. Whole-tree typing is not green.
- Review found dropped whitespace chunks; adjusted chunking and added a regression
  covering a long blank gap followed by indented code. Parent inspected final fix.
- No deployment or live phone acceptance yet. Existing chat messages remain as sent;
  new formatting applies to replies generated after deployment.

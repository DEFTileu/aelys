# Answer trace launch parameter fallback

Scope: IMPLEMENTATION_PLAN Phase 4, existing Telegram answer trace.

The owner reported that a valid answer deep link displayed “Нет ссылки на ответ”.
The published assets match release 363390fb. Railway HTTP logs showed the shell
and assets loading, but no protected trace request for that observed launch.
The actual launch payload was not captured; its credentials must not be logged.

## Confirmed reproduction and change

The official Telegram SDK can restore an outer tgWebAppStartParam into
Telegram.WebView.initParams. The page only checked signed initData, unsafe
initData and the current query/hash, ignoring that SDK source. With synthetic
current authentication lacking start_param and an SDK-cached outer parameter,
the real SDK reproduced the reported error.

Use the SDK outer parameter as the last fallback. Existing explicit values keep
priority and malformed explicit values still fail validation. Authentication
remains the unchanged in-memory initData, checked by the server; a run ID grants
no access. There are no migrations or changes to part 2 history.

## Verification and limits

- GPT-6.2 Sol implemented; GPT-6.1 Sol reviewed with no actionable findings.
- Before the fix: 23 browser tests passed, 1 failed at the missing-ID error.
- After the fix: 24 passed, 0 skipped, independently rerun by the parent.
- Tests use installed Chrome, the official SDK and synthetic authentication.
- Covered recovered start parameter, current query priority over a different
  cached run, invalid explicit parameter rejection and credential cleanup.
- This proves a failure path, not the cause of the owner's actual Telegram launch.
  Live device acceptance remains outstanding. No deployment is claimed here.

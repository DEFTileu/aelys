# Follow-up after 3bb98c5

The reference designs are in the design project, not in the repo. Copy the `design/` folder from the archive into the repo root (`aelys/design/`) and open the `.dc.html` files in a browser. The ones you need: `AelysChat.dc.html`, `AelysSettings.dc.html`, `AelysMessages.dc.html`, `AelysSkeleton.dc.html`, `AelysApps.dc.html`.

## 1. AI Chat: there is data, here is what to use

The backend already sends everything needed (`backend/app/ai/execution.py`):

| Design | Source |
|---|---|
| Meta "Claude · Sonnet 4.5 · 3.2s · ≈$0.004" | `ai.run.started` → `provider`, `model`; time = client-side `completed − started`; `ai.run.completed` → `estimated_cost`. Show the cost instead of tokens: `text_length` is characters, not tokens |
| Regenerate | a new `createAIRun` with the same `message` and the current `routing`. Replace the old answer in the UI, keep it in history |
| Stop | already exists (cancel). Keep the partial text, show the "Stopped" label. `ai.run.cancelled` ≠ done |
| Error card | `ai.run.failed` → `code`, `message`. Buttons: Retry, and "Try <the fastest connected model>" |
| Run steps | **no events for them yet.** Don't fake it: for now show three dots until the first `ai.text.delta`. When tool and knowledge events are added (`ai.tool.started` / `ai.tool.completed` with `{source, label, detail}`), the same component will show them |

### Model picker without new backend tables
- Keep the model catalog on the frontend: `apps/web/src/data/aiModels.ts`, keyed by `provider.kind` (`claude`, `openrouter`). For each model: `id, name, description, context_tokens, speed: 1–3, cost: 0–4, capabilities: ('tools'|'vision'|'thinking')[]`. If `provider.model_policy.models` has data, it overrides the catalog.
- Show only the providers from `aiProviders()` (enabled + a secret saved). Show the rest as disabled rows with a "Add key" link → Settings › AI & models.
- Auto = `routing.model: 'auto'` (that value is already sent).
- Store the chosen model per chat: `conversation.tool_scope_json.routing` or localStorage `aelys.chat.<id>.model`. The default for new chats → localStorage `aelys.chat.defaultModel`.

### Reasoning effort
- UI: a segmented control Off / Low / Medium / High in the picker footer, only for models with `thinking`. Chip on the model pill: "🧠 Med".
- Backend (a small change): accept `routing.effort` in `createAIRun`.
  - Claude: `thinking: { type: 'adaptive' }` + `output_config: { effort }`, off = no field.
  - OpenRouter: `reasoning: { effort: 'low'|'medium'|'high' }`.
  - Unknown value → 400 `INVALID_EFFORT`.
- Meta line: "… · medium effort".

## 2. Global "Can’t reach Aelys"
Don't delete the status logic; centralize it. One place (`AppShell`): if `apiStatus === 'offline'` and the screen has no data yet → the full card from `AelysSkeleton` (phase=error). If there is data → a quiet toast "Offline · changes will sync" once, with no pill.

## 3. Mail Compose
On desktop: one primary "Compose" button in the left column above Mailboxes; the "⋯" menu (Import .eml, Load older, Gmail) sits next to it. On mobile: a FAB in the bottom right, 56px, above the safe-area.

## 4. Gmail in Settings
Settings › System › **Connected accounts**: rows for Gmail / Telegram with status, account and Disconnect. In Mail, only "⋯ › Manage accounts" remains, linking there.

## 5. Telegram "Reply with" and the provider's models
Use the same picker component as the chat, in compact mode (a select-pill → popover). The data comes from the same `aiModels.ts` + `aiProviders()`. Nothing new is needed from the backend: `TelegramSettings` already sends `provider_id` + `model`.

## 6. Wallpaper by weather
No backend needed: `lib/weather.ts` already returns `weather_code` and `is_day`. Mapping: 0–1 → clear, 2–3 → cloudy, 45–67/80–82 → rain, 71–77/85–86 → snow, `is_day=0` → night. Five photos in `apps/web/public/wallpapers/{clear,cloudy,rain,snow,night}.jpg`; until we hand over the photos, use the current one for all five. A crossfade of 600ms when the state changes; off under reduce-motion.

## 7. Screenshots (definition of done)
Playwright: each route at 1440×900 and 390×844, light and dark → `output/design-check/<route>-<w>-<theme>.png`. Attach the archive to the PR.

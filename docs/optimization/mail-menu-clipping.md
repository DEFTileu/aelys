# Mail actions menu clipping

Task: IMPLEMENTATION_PLAN Phase 3, task 4 (Mail message/import/draft).

The desktop More menu opened to the right of the last button in the mailboxes
panel. The panel scrolls vertically, so its overflow also clipped the menu
horizontally and hid most action labels. Align the menu's right edge with its
trigger at every breakpoint, retaining the existing panel scrolling and compact
alignment.

Assumption: this is a layout repair to the existing approved Mail interface.
No product decision or OPEN question is resolved by this change.

Validation:

- `pnpm --filter @aelys/web test -- src/tests/connected-workspaces.test.tsx
  src/tests/settings-accounts.test.tsx src/tests/search-destination-intents.test.tsx`:
  the runner executed the full web suite, 585 tests / 75 files passed.
- `pnpm --filter @aelys/web build`: TypeScript and production build passed;
  the existing bundle size warning remains.
- Browser layout fixture using the actual Mail styles: five menu labels fit
  inside the scrollable desktop panel with no horizontal scrollbar at observed
  CSS viewport widths 1333, 1600 and 2133px.
- Signed macOS release build and `codesign --verify --deep --strict` passed.
  Installed app: opened Mail → Drafts → More, visually confirmed all four
  available action labels render fully inside the panel. Gmail stayed connected;
  the sidebar still shows 25 imported messages.

No backend, OAuth configuration, data model or API contract changes are needed.

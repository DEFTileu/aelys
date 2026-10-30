# Entry screen design follow-up

Owner request (2026-10-30): redesign the disliked entry screen after Keychain
recovery. Selected task: IMPLEMENTATION_PLAN Phase 8, UI consistency; scope is
entry/Touch ID/Keychain presentation, not a redesign of authenticated modules.

Design uses a neutral #F7F8FB canvas, #242631 text, #656B7B secondary text,
#DFE2EA borders, #6246DF actions and #EEEBFB icon background. Native system
sans typography and one centered 340px column replace the gradient and generic
white card. An authored inline fingerprint is the main visual; the smaller
Aelys mark sits in the header and connection/gallery actions in the footer.
No wallpaper, stock image, downloaded font or animation library was added.
Short instructions and a collapsed password explanation reduce Keychain noise.
The existing origin-bound authorization handlers and Rust policy are unchanged.

Files: `apps/web/src/components/AuthGate.tsx`, `auth-entry.css`,
`KeychainAccessRecovery.tsx`, `keychain-recovery.css` and the safe notice string
in `lib/nativeTransport.ts`. Existing auth/settings tests were updated for the
shorter visible copy and the recovery button's pending label. No new behavioral
feature or mock authorization was added.

Validation:

- `pnpm --filter @aelys/web typecheck`: pass.
- `pnpm --filter @aelys/web test`: 202 passed in 31 files. An initial run caught
  a test selecting a pending button by its previous label; the assertion now
  retains the button reference and still verifies that it is disabled.
- Production web build and unsigned arm64 `.app` rebundle: pass, 27.61 MiB.
- Executable SHA-256:
  `3cafe306521f02ea7379d66fe1c26c015ed677db21b0a770caa8200285b75d9a`.
- Real native screenshots inspected: `output/auth-entry/touch-id.png` and
  `password.png`. Password fallback and explicit return controls remain present.
- Browser entry and expanded server form checked: actual viewport was clamped
  to 433px, document scrollWidth also 433px, no horizontal overflow. A requested
  390px observation is not claimed. Screenshot: `password-mobile.png`. Temporary
  viewport reset and temporary browser tab closed afterwards.
- Native AX verified the compact Keychain state with its permission button and
  collapsed password guidance. Its screenshot capture failed with -3811; the
  normal Touch ID/password screenshots were captured successfully.

The owner must still approve any OS credential/trust prompt. Rebuilding this
ad-hoc development binary can require new Keychain permission; visual completion
does not close certificate/signing or authenticated-restart acceptance. No login,
Keychain grant, personal record mutation, staging, commit or publication was
performed during visual validation.

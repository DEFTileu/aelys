# Android in-app update implementation plan

**Goal:** Phase 8 installer slice: the owner opens Android Aelys, sees an available update, taps Update, and confirms Android installation without finding an APK manually.

**Approved approach:** Owner selected the third-party Android Installer for Tauri on 2026-11-13 after comparing Obtainium, Play updates, and Capacitor live updates. Keep the existing wrapper and settings styles. This approval covers implementation; publishing releases is not authorized.

**Architecture:** A Rust downloader reads an HTTPS release manifest, compares stable versions, streams an APK into private app cache with size/SHA-256 checks, and invokes pinned `tauri-plugin-android-installer` 0.1.0 from Rust. The frontend cannot select paths/URLs or invoke the install plugin directly. A shared React controller checks once after authentication and exposes update/retry in the existing About panel and a startup notice.

**Assumptions / OPEN:** Default channel is this repository's GitHub Releases (`android-update.json`). Custom HTTPS channels may be selected at build time. Release signing, initial signed installation, publication, and physical-device acceptance remain operator gates; no connected Android device was found. ADR-006 remains PROPOSED. No backend migration is needed: update artifacts are public application code, with no owner credentials, API calls, sync, or telemetry.

**Contract:** manifest `{schema_version:1, package_id:"com.aelys.mobile", version:"0.1.1", version_code:1001001, targets:{"android-aarch64":{url:"https://.../aelys-android-aarch64.apk",sha256:"<64 hex>",size_bytes:123}}}`. Native check returns `{supported:boolean,current_version:string,update:{version:string,size_bytes:number}|null}`. Download receives only `onProgress:Channel<{downloaded:number,total:number}>`. Install returns `"installer_opened"` or rejects with a stable code (including `UPDATE_PERMISSION_REQUIRED`). Install never claims completion; the next process launch reads the installed version.

## Global constraints

- HTTPS only, bounded redirects to trusted HTTPS delivery hosts, bounded metadata/APK sizes and timeouts, no credentials or request content logging.
- Reject malformed manifests, mismatched package/architecture, prerelease/downgrade versions, invalid hashes and truncated downloads; never install partial files.
- Serialize native update operations; installation only uses the artifact selected and validated by a successful check/download in this process.
- Check automatically; download/install/permission prompts only follow an explicit owner click. Offline check failures must not block ordinary use.
- Preserve existing dirty files; Git index belongs to the lead. Work in place for this narrow slice; no unrelated commits or publication.

## Tasks

- [x] Native core: write failing manifest/download tests; implement HTTPS release selection, bounded verified download, error codes; run Rust tests.
- [x] Mobile integration: pin/register installer without granting its JS commands, add bounded wrapper commands and capabilities; cargo check and Android APK build.
- [x] React flow: write failing controller/component tests, implement startup check/notice and About controls using the native contract; run targeted tests/typecheck/build.
- [x] Release tooling: test then implement APK identity/signature validation and manifest generation; document signing, URLs, update steps, and device acceptance.
- [x] Review complete diff, run combined checks, record exact results and remaining device/release gates; create one atomic explicit-path checkpoint commit.

## Review focus

Network failure cannot break the workspace; cancelled installation/permission retains retry; concurrent views cannot start duplicate downloads; corrupted/oversized APKs never reach installer; absence of a published manifest is shown honestly.

## Progress

Baseline: mobile script tests 5/5 and settings navigation tests 8/8 pass. No Android device attached (`adb devices`). Existing unrelated changes are present in shell, notes, desktop config, and local agent files.

Review fixes: clear stale frontend offers when checking invalidates native state;
download again after a lost/corrupt cached file; verify the actual APK's identity
and signing lineage before opening the system installer. The added native-only
`packages/android-update-verifier` bridge registers no frontend commands and
accepts no path argument. It uses the fixed update-cache location and rejects
symlink escapes below the canonical Android cache root.

Validation commands and evidence (2026-11-13):

- `pnpm --filter @aelys/web test`: 937 tests passed; targeted updater/settings run: 19 passed.
- `pnpm --filter @aelys/web typecheck`: passed. Web build passed as part of Android builds (existing large-chunk warning).
- `pnpm --filter @aelys/mobile test`: 11 passed.
- `cargo test --manifest-path packages/android-updater/Cargo.toml --locked`: 5 passed.
- `cargo clippy --manifest-path packages/android-updater/Cargo.toml --all-targets --locked -- -D warnings`: passed.
- `cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml --locked`: passed.
- Rust formatting checks for updater, verifier and mobile host: passed.
- Generated Android Gradle `:tauri-plugin-aelys-update-verifier:testDebugUnitTest`: 4 JVM tests passed (package/version/signer/rotation/multisigner checks and filesystem alias/escape checks).
- Tauri Android arm64 debug and optimized release APK builds: passed with existing Gradle/JDK deprecation warnings. First attempt lacked rustup on PATH; corrected with the documented Rust toolchain PATH.
- SDK `apksigner verify`: development APK signature verified; `aapt dump xmltree`: installation permission present and cleartext disabled. Manifest generation exercised against an actual development-signed optimized APK, not just fixture bytes.

Local artifacts are under ignored `output/android/in-app-update/`; the generated
development manifest uses an illustrative release URL and is not published.
The initial APK is signed only with the pre-existing local Android development
key, not a production signing key. Physical-device installation, persistence
across replacement, actual permission screens, and a live published update
channel remain unverified. HTTP integration tests for actual interrupted TLS
downloads/redirect chains are also deferred; URL/redirect policies and streamed
file corruption/partial-file cleanup are covered in core unit tests.
The final independent review found no additional confirmed important issue
after the fixes. The optimized release DEX contains both annotated plugin
entrypoints, the fixed cache path, and the validation error code. Phase 8 and
ADR-006 are not marked complete.

# Aelys mobile shell

This is the Android Tauri 2 spike target sharing the React web application.
The final mobile wrapper remains an open decision under ADR-006. This shell
does not claim Android support until Tauri Android initialization, APK build,
offline persistence and notification/background-sync checks pass on a machine
with Android Studio, SDK, NDK, Java and platform tools installed.

The mobile command surface deliberately has no vendor execution. Agent runs
remain Mac-only through the authenticated backend/runtime channel.

After prerequisites are installed, the intended validation is:

```sh
pnpm install
pnpm --filter @aelys/mobile exec tauri android init
pnpm --filter @aelys/mobile tauri:android:build
```

Do not use this README as evidence that an APK has already been produced.

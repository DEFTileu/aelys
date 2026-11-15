//! Focus Guard for Android: usage metering, policy and the block screen run on the
//! device; commands are added as the native side lands.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aelys-focus-guard")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin("com.aelys.focusguard", "FocusGuardPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}

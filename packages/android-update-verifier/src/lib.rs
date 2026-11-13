//! Native-only archive identity validation. No frontend commands are registered.
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Expected<'a> {
    version: &'a str,
    version_code: u64,
}

#[cfg(target_os = "android")]
pub struct UpdateVerifier<R: Runtime>(tauri::plugin::PluginHandle<R>);
#[cfg(target_os = "android")]
impl<R: Runtime> UpdateVerifier<R> {
    pub async fn verify(&self, version: &str, version_code: u64) -> Result<(), &'static str> {
        let _: serde::de::IgnoredAny = self
            .0
            .run_mobile_plugin_async(
                "verify",
                Expected {
                    version,
                    version_code,
                },
            )
            .await
            .map_err(|_| "UPDATE_INVALID_APK")?;
        Ok(())
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aelys-update-verifier")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(UpdateVerifier(api.register_android_plugin(
                "com.aelys.updateverifier",
                "UpdateVerifierPlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

use aelys_native_transport as native;
use serde::Serialize;
use tauri::Manager;
mod updates;

#[derive(Debug, Serialize)]
struct MobileRuntimePolicy {
    vendor_execution_enabled: bool,
    offline_storage: &'static str,
    message: &'static str,
}

#[tauri::command]
fn runtime_policy() -> MobileRuntimePolicy {
    MobileRuntimePolicy {
        vendor_execution_enabled: false,
        offline_storage: "IndexedDB in shared web UI; native SQLite adapter remains a follow-up spike",
        message: "Android runtime actions remain limited to authenticated backend APIs; vendor execution is Mac-only and fail-closed.",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_android_installer::init())
        .plugin(tauri_plugin_aelys_update_verifier::init());
    builder
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_aelys_session_store::init())
        .plugin(tauri_plugin_aelys_notification_log::init())
        .setup(|app| {
            app.manage(native::NativeStorage::new(app.handle()));
            Ok(())
        })
        .manage(native::NativeState::default())
        .manage(native::NativeAIStreams::default())
        .manage(updates::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            runtime_policy,
            updates::android_update_check,
            updates::android_update_download,
            updates::android_update_install,
            native::native_status,
            native::native_health,
            native::native_biometric_status,
            native::native_biometric_set,
            native::native_device_reauth,
            native::native_login,
            native::native_enroll,
            native::native_resume,
            native::native_logout,
            native::native_gmail_connect,
            native::native_calendar_connect,
            native::native_operation,
            native::native_operation_diagnostic,
            native::native_ai_events,
            native::native_ai_events_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aelys mobile application");
}

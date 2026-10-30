use aelys_native_transport as native;
use serde::Serialize;
use tauri::Manager;

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
    tauri::Builder::default()
        .plugin(tauri_plugin_aelys_session_store::init())
        .setup(|app| {
            app.manage(native::NativeStorage::new(app.handle()));
            Ok(())
        })
        .manage(native::NativeState::default())
        .manage(native::NativeAIStreams::default())
        .invoke_handler(tauri::generate_handler![
            runtime_policy,
            native::native_status,
            native::native_health,
            native::native_biometric_status,
            native::native_biometric_set,
            native::native_login,
            native::native_resume,
            native::native_logout,
            native::native_operation,
            native::native_ai_events,
            native::native_ai_events_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aelys mobile application");
}

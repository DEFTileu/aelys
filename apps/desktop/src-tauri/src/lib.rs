use aelys_runtime::adapter::{AdapterKind, AgentAdapter, ProcessCommandProbe, VendorAdapter};
use serde::Serialize;
mod native;

#[derive(Debug, Serialize)]
struct RuntimeStatus {
    local_store_configured: bool,
    vendor_execution_enabled: bool,
    message: &'static str,
}

#[tauri::command]
fn runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        local_store_configured: std::env::var_os("AELYS_RUNTIME_DB").is_some(),
        vendor_execution_enabled: false,
        message: "Local runtime is fail-closed until authenticated vendor compatibility and trusted macOS isolation provenance are validated.",
    }
}

#[tauri::command]
fn runtime_capabilities() -> Vec<aelys_runtime::adapter::AdapterCapabilities> {
    [
        (AdapterKind::ClaudeCode, "claude"),
        (AdapterKind::CodexCli, "codex"),
    ]
    .into_iter()
    .map(|(kind, executable)| {
        VendorAdapter::new(kind, executable, ProcessCommandProbe).probe_support()
    })
    .collect()
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            app.manage(native::NativeStorage::new(app.handle()));
            Ok(())
        })
        .manage(native::NativeState::default())
        .manage(native::NativeAIStreams::default())
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            runtime_capabilities,
            native::native_status,
            native::native_health,
            native::native_biometric_status,
            native::native_biometric_set,
            native::native_keychain_authorize,
            native::native_login,
            native::native_resume,
            native::native_logout,
            native::native_operation,
            native::native_ai_events,
            native::native_ai_events_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aelys desktop application");
}

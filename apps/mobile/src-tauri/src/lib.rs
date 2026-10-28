use serde::Serialize;

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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![runtime_policy])
        .run(tauri::generate_context!())
        .expect("error while running Aelys mobile application");
}

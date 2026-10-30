fn main() {
    let commands = &[
        "runtime_policy",
        "native_status",
        "native_health",
        "native_biometric_status",
        "native_biometric_set",
        "native_login",
        "native_resume",
        "native_logout",
        "native_operation",
        "native_ai_events",
        "native_ai_events_close",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("mobile capability manifest must build");
}

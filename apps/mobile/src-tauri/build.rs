fn main() {
    println!("cargo:rerun-if-env-changed=AELYS_ANDROID_UPDATE_URL");
    let commands = &[
        "runtime_policy",
        "android_update_check",
        "android_update_download",
        "android_update_install",
        "native_status",
        "native_health",
        "native_biometric_status",
        "native_biometric_set",
        "native_device_reauth",
        "native_login",
        "native_enroll",
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

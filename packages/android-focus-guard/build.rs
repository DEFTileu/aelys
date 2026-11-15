const COMMANDS: &[&str] = &[
    "status",
    "open_settings",
    "set_state",
    "usage",
    "apply_grant",
    "installed_apps",
    "take_pending_unlock",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}

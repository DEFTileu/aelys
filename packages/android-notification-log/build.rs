const COMMANDS: &[&str] = &["status", "open_access_settings", "list", "remove", "clear", "set_settings", "set_finance"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}

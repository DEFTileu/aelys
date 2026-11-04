#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    {
        let mut args = std::env::args().skip(1);
        if args.next().as_deref() == Some("--cli") {
            std::process::exit(aelys_native_transport::run_cli(args.collect()));
        }
    }
    aelys_desktop_lib::run();
}

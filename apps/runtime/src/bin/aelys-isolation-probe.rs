use aelys_runtime::sandbox::ProbeResult;
use std::env;
use std::fs;
use std::net::TcpStream;
use std::process::Command;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 7 {
        eprintln!("usage: aelys-isolation-probe <project-write> <outside> <credential> <symlink> <network> <challenge>");
        std::process::exit(2);
    }
    let project = &args[1];
    let outside = &args[2];
    let credential = &args[3];
    let symlink = &args[4];
    let network = &args[5];
    let probe_challenge = &args[6];
    let project_write = fs::write(project, "probe").is_ok();
    let outside_read_blocked = fs::read(outside).is_err();
    let credential_read_blocked = fs::read(credential).is_err();
    let symlink_read_blocked = fs::read(symlink).is_err();
    let subprocess_escape_blocked = Command::new("/bin/cat")
        .arg(outside)
        .output()
        .map(|o| !o.status.success())
        .unwrap_or(true);
    let network_blocked = TcpStream::connect(network).is_err();
    println!(
        "{}",
        serde_json::to_string(&ProbeResult {
            probe_challenge: probe_challenge.clone(),
            profile_digest: String::new(),
            runtime_digest: String::new(),
            probe_digest: String::new(),
            project_write,
            outside_read_blocked,
            credential_read_blocked,
            symlink_read_blocked,
            subprocess_escape_blocked,
            network_blocked
        })
        .unwrap()
    );
}

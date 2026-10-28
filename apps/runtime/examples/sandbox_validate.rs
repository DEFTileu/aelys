use aelys_runtime::sandbox::{run_probe, SandboxProfile};
use std::fs;
use std::net::TcpListener;
use tempfile::tempdir;
use uuid::Uuid;

fn main() {
    let root = tempdir().expect("root");
    let project = root.path().join("project");
    let outside = root.path().join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let outside_file = outside.join("secret");
    fs::write(&outside_file, "secret").unwrap();
    let credential = outside.join("credential");
    fs::write(&credential, "key").unwrap();
    let symlink = project.join("escape");
    std::os::unix::fs::symlink(&outside_file, &symlink).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let challenge = Uuid::new_v4().to_string();
    let probe = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("aelys-isolation-probe");
    let result = run_probe(
        &SandboxProfile::new(&project).unwrap(),
        &probe,
        &[
            project.join("written").into(),
            outside_file.into(),
            credential.into(),
            symlink.into(),
            address.to_string().into(),
            challenge.clone().into(),
        ],
    )
    .expect("probe");
    println!("{}", serde_json::to_string(&result).unwrap());
    assert!(result.valid());
    assert_eq!(result.probe_challenge, challenge);
}

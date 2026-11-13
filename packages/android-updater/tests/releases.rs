use aelys_android_updater::{select_release, verify_artifact, Source, MAX_APK_BYTES};
use serde_json::{json, Value};

fn manifest() -> Value {
    json!({"schema_version":1,"package_id":"com.aelys.mobile","version":"0.2.0","version_code":2000000,
        "targets":{"android-aarch64":{"url":"https://github.com/DEFTileu/aelys/releases/download/v0.2.0/aelys-android-aarch64.apk","sha256":"a".repeat(64),"size_bytes":100}}})
}
fn select(value: Value) -> Result<Option<String>, &'static str> {
    select_release(
        &Source::new(
            "https://github.com/DEFTileu/aelys/releases/latest/download/android-update.json",
        )?,
        &serde_json::to_vec(&value).unwrap(),
        "0.1.0",
        "android-aarch64",
    )
    .map(|r| r.map(|r| r.version))
}
#[test]
fn selects_only_new_stable_matching_package_and_target() {
    assert_eq!(select(manifest()).unwrap(), Some("0.2.0".into()));
    for version in ["0.1.0", "0.0.9", "0.2.0-beta.1"] {
        let mut m = manifest();
        m["version"] = json!(version);
        assert_eq!(select(m).unwrap(), None);
    }
    let mut m = manifest();
    m["package_id"] = json!("com.other.app");
    assert_eq!(select(m), Err("UPDATE_INVALID_MANIFEST"));
    let mut m = manifest();
    m["targets"] = json!({});
    assert_eq!(select(m), Err("UPDATE_TARGET_UNAVAILABLE"));
}
#[test]
fn rejects_untrusted_urls_hashes_sizes_and_unknown_schema() {
    for url in [
        "http://github.com/DEFTileu/aelys/releases/download/v1/app.apk",
        "https://evil.test/app.apk",
        "https://github.com/other/repo/releases/download/v1/app.apk",
        "https://user:secret@github.com/DEFTileu/aelys/releases/download/v1/app.apk",
        "https://github.com/DEFTileu/aelys/releases/download/v1/app.apk?x=1",
    ] {
        let mut m = manifest();
        m["targets"]["android-aarch64"]["url"] = json!(url);
        assert_eq!(select(m), Err("UPDATE_INVALID_MANIFEST"), "{url}");
    }
    for size in [0, MAX_APK_BYTES + 1] {
        let mut m = manifest();
        m["targets"]["android-aarch64"]["size_bytes"] = json!(size);
        assert_eq!(select(m), Err("UPDATE_INVALID_MANIFEST"));
    }
    let mut m = manifest();
    m["targets"]["android-aarch64"]["sha256"] = json!("z".repeat(64));
    assert_eq!(select(m), Err("UPDATE_INVALID_MANIFEST"));
    let mut m = manifest();
    m["schema_version"] = json!(2);
    assert_eq!(select(m), Err("UPDATE_INVALID_MANIFEST"));
}
#[test]
fn custom_channel_only_accepts_its_own_origin() {
    let s = Source::new("https://updates.example.org/android.json").unwrap();
    assert!(s.allows_artifact("https://updates.example.org/releases/app.apk"));
    assert!(!s.allows_artifact("https://other.example.org/app.apk"));
    assert!(!s.allows_artifact("https://updates.example.org:444/app.apk"));
    assert!(Source::new("http://updates.example.org/android.json").is_err());
    assert!(Source::new("https://token@updates.example.org/android.json").is_err());
    assert!(s.allows_redirect(&url::Url::parse("https://updates.example.org/file").unwrap()));
    assert!(!s.allows_redirect(&url::Url::parse("http://updates.example.org/file").unwrap()));
    assert!(!s.allows_redirect(
        &url::Url::parse("https://release-assets.githubusercontent.com/file").unwrap()
    ));
}
#[test]
fn rejects_truncated_or_corrupted_apk_and_accepts_valid_bytes() {
    let hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert!(verify_artifact(b"abc", 3, hash).is_ok());
    assert_eq!(
        verify_artifact(b"ab", 3, hash),
        Err("UPDATE_INTEGRITY_FAILED")
    );
    assert_eq!(
        verify_artifact(b"abd", 3, hash),
        Err("UPDATE_INTEGRITY_FAILED")
    );
}

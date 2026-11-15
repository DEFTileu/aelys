//! Focus Guard for Android: usage metering, policy and the block screen run on the
//! device. The web UI reaches them through these commands only; every payload is validated
//! here first and again in Kotlin, because this is the boundary to the enforcement state.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::marker::PhantomData;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

pub struct FocusGuard<R: Runtime = tauri::Wry> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    _runtime: PhantomData<fn() -> R>,
}

/// Codes Kotlin may reject with that the web layer is allowed to see; everything else is `FOCUS_ERROR`.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn reject_code(code: Option<&str>) -> &'static str {
    match code {
        Some("INVALID_STATE") => "INVALID_STATE",
        Some("INVALID_GRANT") => "INVALID_GRANT",
        Some("INVALID_TARGET") => "INVALID_TARGET",
        _ => "FOCUS_ERROR",
    }
}

impl<R: Runtime> FocusGuard<R> {
    async fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        #[cfg(target_os = "android")]
        {
            use tauri::plugin::mobile::PluginInvokeError;
            self.handle
                .run_mobile_plugin_async::<Value>(command, args)
                .await
                .map_err(|e| match e {
                    PluginInvokeError::InvokeRejected(r) => {
                        reject_code(r.code.as_deref()).to_owned()
                    }
                    _ => "FOCUS_ERROR".to_owned(),
                })
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (command, args);
            Err("UNSUPPORTED_PLATFORM".into())
        }
    }
}

const MAX_APPS: usize = 30;
const MAX_PACKAGES: usize = 10;
const MAX_LABEL_CHARS: usize = 60;
const MAX_GRANT_SECONDS: i64 = 600;
const TARGETS: [&str; 3] = ["usage", "accessibility", "app"];

/// One guarded app group; `limit_minutes` stays in minutes on the wire, Kotlin converts it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FocusApp {
    id: String,
    label: String,
    packages: Vec<String>,
    limit_minutes: i64,
}

/// What the web layer owns of the guard state; grants stay on the device.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardState {
    effective: Vec<FocusApp>,
    /// `None` = no pending config; `Some(vec![])` = a real "remove all apps" config.
    pending: Option<Vec<FocusApp>>,
    effective_from: Option<String>,
    day_unlocked_on: Option<String>,
}

fn valid_package(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

fn valid_app_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// `YYYY-MM-DD` and a real calendar day (ASCII digits only).
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let part = &s[r];
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (Some(y), Some(m), Some(d)) = (num(0..4), num(5..7), num(8..10)) else {
        return false;
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (1..=12).contains(&m) && d >= 1 && d <= days[m as usize - 1]
}

fn validate_apps(apps: &[FocusApp]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    let ok = apps.len() <= MAX_APPS
        && apps.iter().all(|a| {
            valid_app_id(&a.id)
                && ids.insert(a.id.as_str())
                && (1..=MAX_LABEL_CHARS).contains(&a.label.chars().count())
                && (1..=MAX_PACKAGES).contains(&a.packages.len())
                && a.packages.iter().all(|p| valid_package(p))
                && (1..=1440).contains(&a.limit_minutes)
        });
    if ok {
        Ok(())
    } else {
        Err("INVALID_STATE".into())
    }
}

fn validate_state(state: &GuardState) -> Result<(), String> {
    validate_apps(&state.effective)?;
    if let Some(pending) = &state.pending {
        validate_apps(pending)?;
    }
    let dates_ok = [&state.effective_from, &state.day_unlocked_on]
        .into_iter()
        .all(|d| d.as_deref().is_none_or(valid_date));
    if dates_ok {
        Ok(())
    } else {
        Err("INVALID_STATE".into())
    }
}

/// Whether `app_id` is in the current config is checked on the device, which holds the state.
fn validate_grant(app_id: &str, seconds: i64, day: &str) -> Result<(), String> {
    if valid_app_id(app_id) && (1..=MAX_GRANT_SECONDS).contains(&seconds) && valid_date(day) {
        Ok(())
    } else {
        Err("INVALID_GRANT".into())
    }
}

fn validate_target(target: &str) -> Result<(), String> {
    if TARGETS.contains(&target) {
        Ok(())
    } else {
        Err("INVALID_TARGET".into())
    }
}

fn guard<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, FocusGuard<R>> {
    app.state::<FocusGuard<R>>()
}

#[tauri::command]
async fn status<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    guard(&app).call("status", json!({})).await
}

#[tauri::command]
async fn open_settings<R: Runtime>(app: AppHandle<R>, target: String) -> Result<Value, String> {
    validate_target(&target)?;
    guard(&app)
        .call("openSettings", json!({ "target": target }))
        .await
}

#[tauri::command]
async fn set_state<R: Runtime>(app: AppHandle<R>, state: GuardState) -> Result<Value, String> {
    validate_state(&state)?;
    let args = serde_json::to_value(&state).map_err(|_| "FOCUS_ERROR".to_owned())?;
    guard(&app).call("setState", args).await
}

#[tauri::command]
async fn usage<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    guard(&app).call("usage", json!({})).await
}

#[tauri::command]
async fn apply_grant<R: Runtime>(
    app: AppHandle<R>,
    app_id: String,
    seconds: i64,
    day: String,
) -> Result<Value, String> {
    validate_grant(&app_id, seconds, &day)?;
    guard(&app)
        .call(
            "applyGrant",
            json!({ "appId": app_id, "seconds": seconds, "day": day }),
        )
        .await
}

#[tauri::command]
async fn installed_apps<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    guard(&app).call("installedApps", json!({})).await
}

/// The app id whose block-screen Unlock button was pressed (cleared on read), or null.
#[tauri::command]
async fn take_pending_unlock<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    guard(&app).call("takePendingUnlock", json!({})).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aelys-focus-guard")
        .invoke_handler(tauri::generate_handler![
            status,
            open_settings,
            set_state,
            usage,
            apply_grant,
            installed_apps,
            take_pending_unlock
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin("com.aelys.focusguard", "FocusGuardPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            app.manage(FocusGuard::<R> {
                #[cfg(target_os = "android")]
                handle,
                _runtime: PhantomData,
            });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn app(id: &str, packages: &[&str], limit: i64) -> FocusApp {
        FocusApp {
            id: id.into(),
            label: "App".into(),
            packages: packages.iter().map(|p| (*p).into()).collect(),
            limit_minutes: limit,
        }
    }

    fn state(effective: Vec<FocusApp>) -> GuardState {
        GuardState {
            effective,
            pending: None,
            effective_from: None,
            day_unlocked_on: None,
        }
    }

    fn one(a: FocusApp) -> GuardState {
        state(vec![a])
    }

    #[test]
    fn accepts_a_valid_state() {
        let mut s = state(vec![
            app("instagram", &["com.instagram.android"], 60),
            app(
                "tiktok",
                &["com.zhiliaoapp.musically", "com.ss.android.ugc.trill"],
                1440,
            ),
        ]);
        s.pending = Some(vec![app("instagram", &["com.instagram.android"], 1)]);
        s.effective_from = Some("2028-02-29".into());
        s.day_unlocked_on = Some("2026-11-15".into());
        assert_eq!(validate_state(&s), Ok(()));
    }

    #[test]
    fn pending_null_and_empty_list_are_both_valid() {
        let mut s = state(vec![]);
        assert_eq!(validate_state(&s), Ok(()));
        s.pending = Some(vec![]);
        s.effective_from = Some("2026-11-16".into());
        assert_eq!(validate_state(&s), Ok(()));
    }

    #[test]
    fn state_is_forwarded_with_the_kotlin_keys() {
        let s: GuardState = serde_json::from_value(json!({
            "effective": [{"id": "a", "label": "A", "packages": ["a.b"], "limit_minutes": 5}],
            "pending": null, "effectiveFrom": null, "dayUnlockedOn": "2026-11-15"
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "effective": [{"id": "a", "label": "A", "packages": ["a.b"], "limit_minutes": 5}],
                "pending": null, "effectiveFrom": null, "dayUnlockedOn": "2026-11-15"
            })
        );
        assert!(serde_json::from_value::<GuardState>(json!({"effective": [], "pending": null, "effectiveFrom": null, "dayUnlockedOn": null, "grants": {}})).is_err());
    }

    #[test]
    fn rejects_limit_over_a_day() {
        assert_eq!(
            validate_state(&one(app("a", &["a.b"], 1441))),
            Err("INVALID_STATE".into())
        );
        assert!(validate_state(&one(app("a", &["a.b"], i64::MAX))).is_err());
        let mut s = state(vec![]);
        s.pending = Some(vec![app("a", &["a.b"], 1441)]);
        assert!(validate_state(&s).is_err());
    }

    #[test]
    fn rejects_limit_below_one_minute() {
        for bad in [0, -1, i64::MIN] {
            assert_eq!(
                validate_state(&one(app("a", &["a.b"], bad))),
                Err("INVALID_STATE".into())
            );
        }
    }

    #[test]
    fn rejects_bad_package_names() {
        let long = "a".repeat(256);
        for bad in [
            "",
            "com/foo",
            "com.foo bar",
            "../etc",
            "com.foo;",
            "cömfoo",
            long.as_str(),
        ] {
            assert!(validate_state(&one(app("a", &[bad], 60))).is_err(), "{bad}");
        }
        assert!(validate_state(&one(app("a", &[&"a".repeat(255)], 60))).is_ok());
    }

    #[test]
    fn rejects_bad_app_ids_labels_and_duplicates() {
        for bad in ["", "Insta", "a b", &"a".repeat(41), "../x"] {
            assert!(
                validate_state(&one(app(bad, &["a.b"], 60))).is_err(),
                "{bad}"
            );
        }
        assert!(
            validate_state(&state(vec![app("d", &["a.b"], 60), app("d", &["c.d"], 60)])).is_err()
        );
        let mut a = app("a", &["a.b"], 60);
        a.label = String::new();
        assert!(validate_state(&one(a.clone())).is_err());
        a.label = "x".repeat(61);
        assert!(validate_state(&one(a)).is_err());
    }

    #[test]
    fn rejects_too_many_apps_or_packages() {
        let apps = |n: usize| {
            (0..n)
                .map(|i| app(&format!("app{i}"), &["a.b"], 60))
                .collect::<Vec<_>>()
        };
        assert!(validate_state(&state(apps(30))).is_ok());
        assert!(validate_state(&state(apps(31))).is_err());
        let mut s = state(vec![]);
        s.pending = Some(apps(31));
        assert!(validate_state(&s).is_err());
        let pk = |n: usize| (0..n).map(|i| format!("com.p{i}")).collect::<Vec<_>>();
        let with = |n: usize| {
            let mut a = app("a", &[], 60);
            a.packages = pk(n);
            one(a)
        };
        assert!(validate_state(&with(10)).is_ok());
        assert!(validate_state(&with(11)).is_err());
        assert!(validate_state(&with(0)).is_err());
    }

    #[test]
    fn rejects_bad_dates() {
        for bad in [
            "2026-02-29",
            "2026-13-01",
            "2026-00-10",
            "2026-11-31",
            "26-11-15",
            "2026-1-5",
            "",
            "2026-11-15T00",
            "２０２６-11-15",
        ] {
            let mut s = state(vec![]);
            s.effective_from = Some(bad.into());
            assert!(validate_state(&s).is_err(), "{bad}");
            let mut s = state(vec![]);
            s.day_unlocked_on = Some(bad.into());
            assert!(validate_state(&s).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_grant_over_ten_minutes() {
        assert_eq!(validate_grant("instagram", 600, "2026-11-15"), Ok(()));
        assert_eq!(validate_grant("instagram", 1, "2026-11-15"), Ok(()));
        for bad in [0, -1, 601, i64::MAX] {
            assert_eq!(
                validate_grant("instagram", bad, "2026-11-15"),
                Err("INVALID_GRANT".into())
            );
        }
        assert!(validate_grant("Bad Id", 60, "2026-11-15").is_err());
        assert!(validate_grant("instagram", 60, "2026-11-31").is_err());
    }

    #[test]
    fn rejects_unknown_settings_target() {
        for ok in ["usage", "accessibility", "app"] {
            assert_eq!(validate_target(ok), Ok(()));
        }
        for bad in ["", "wifi", "USAGE", "usage ", "app/../x"] {
            assert_eq!(validate_target(bad), Err("INVALID_TARGET".into()));
        }
    }

    #[test]
    fn plugin_rejections_keep_only_the_known_codes() {
        for code in ["INVALID_STATE", "INVALID_GRANT", "INVALID_TARGET"] {
            assert_eq!(reject_code(Some(code)), code);
        }
        for other in [Some("FOCUS_BUSY"), Some("x"), None] {
            assert_eq!(reject_code(other), "FOCUS_ERROR");
        }
    }
}

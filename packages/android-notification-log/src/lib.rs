//! On-device notification log for Android. Notifications are captured by a
//! NotificationListenerService into app-private storage and never leave the phone;
//! the web UI reads them through these commands only.
use serde::Deserialize;
use serde_json::{json, Value};
use std::marker::PhantomData;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

pub struct NotificationLog<R: Runtime = tauri::Wry> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    _runtime: PhantomData<fn() -> R>,
}

impl<R: Runtime> NotificationLog<R> {
    async fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin_async::<Value>(command, args)
                .await
                .map_err(|_| "LOG_ERROR".to_owned())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (command, args);
            Err("UNSUPPORTED_PLATFORM".into())
        }
    }
}

const KEEP_DAYS: [u32; 3] = [7, 30, 90];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    hide_codes: bool,
    keep_days: u32,
    muted: Vec<String>,
}

fn valid_package(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

fn validate_settings(settings: &Settings) -> Result<(), String> {
    if !KEEP_DAYS.contains(&settings.keep_days)
        || settings.muted.len() > 500
        || !settings.muted.iter().all(|p| valid_package(p))
    {
        return Err("INVALID_SETTINGS".into());
    }
    Ok(())
}

fn validate_tx(tx: &Option<String>) -> Result<(), String> {
    match tx {
        Some(id) if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => {
            Err("INVALID_TRANSACTION".into())
        }
        _ => Ok(()),
    }
}

fn log<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, NotificationLog<R>> {
    app.state::<NotificationLog<R>>()
}

#[tauri::command]
async fn status<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    log(&app).call("status", json!({})).await
}

#[tauri::command]
async fn open_access_settings<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    log(&app).call("openAccessSettings", json!({})).await
}

#[tauri::command]
async fn list<R: Runtime>(app: AppHandle<R>, limit: Option<u32>) -> Result<Value, String> {
    log(&app).call("list", json!({ "limit": limit.unwrap_or(500).clamp(1, 2000) })).await
}

#[tauri::command]
async fn remove<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<Value, String> {
    log(&app).call("remove", json!({ "id": id })).await
}

#[tauri::command]
async fn clear<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    log(&app).call("clear", json!({})).await
}

#[tauri::command]
async fn set_settings<R: Runtime>(app: AppHandle<R>, settings: Settings) -> Result<Value, String> {
    validate_settings(&settings)?;
    log(&app)
        .call("setSettings", json!({ "hideCodes": settings.hide_codes, "keepDays": settings.keep_days, "muted": settings.muted }))
        .await
}

/// Links a log entry to the Finances transaction created from it (or unlinks with `null`).
#[tauri::command]
async fn set_finance<R: Runtime>(app: AppHandle<R>, id: i64, transaction: Option<String>) -> Result<Value, String> {
    validate_tx(&transaction)?;
    log(&app).call("setFinance", json!({ "id": id, "transaction": transaction })).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aelys-notification-log")
        .invoke_handler(tauri::generate_handler![status, open_access_settings, list, remove, clear, set_settings, set_finance])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin("com.aelys.notificationlog", "NotificationLogPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            app.manage(NotificationLog::<R> {
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

    #[test]
    fn settings_are_bounded() {
        let ok = Settings { hide_codes: true, keep_days: 30, muted: vec!["kz.kaspi.mobile".into()] };
        assert!(validate_settings(&ok).is_ok());
        for bad in [
            Settings { hide_codes: true, keep_days: 31, muted: vec![] },
            Settings { hide_codes: true, keep_days: 30, muted: vec!["../etc".into()] },
            Settings { hide_codes: true, keep_days: 30, muted: vec![String::new()] },
        ] {
            assert!(validate_settings(&bad).is_err());
        }
    }

    #[test]
    fn transaction_ids_are_plain() {
        assert!(validate_tx(&None).is_ok());
        assert!(validate_tx(&Some("3f2a-11".into())).is_ok());
        assert!(validate_tx(&Some("x'; drop".into())).is_err());
        assert!(validate_tx(&Some(String::new())).is_err());
    }
}

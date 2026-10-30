//! Phase 0 Android session-store spike. No frontend commands are registered.
use std::marker::PhantomData;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
use serde::{Deserialize, Serialize};

pub struct AndroidSessionStore<R: Runtime = tauri::Wry> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    _runtime: PhantomData<fn() -> R>,
}

impl<R: Runtime> Clone for AndroidSessionStore<R> {
    fn clone(&self) -> Self {
        Self {
            #[cfg(target_os = "android")]
            handle: self.handle.clone(),
            _runtime: PhantomData,
        }
    }
}

fn validate_origin(origin: &str) -> Result<(), String> {
    if origin.len() > 2048 {
        return Err("INVALID_ORIGIN".into());
    }
    let url = url::Url::parse(origin).map_err(|_| "INVALID_ORIGIN".to_owned())?;
    let canonical = url.origin().ascii_serialization();
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || origin != canonical
    {
        return Err("INVALID_ORIGIN".into());
    }
    Ok(())
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct Request<'a> {
    origin: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<&'a str>,
}
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct Response {
    record: Option<String>,
}

impl<R: Runtime> AndroidSessionStore<R> {
    pub async fn read(&self, origin: &str) -> Result<Option<String>, String> {
        validate_origin(origin)?;
        #[cfg(target_os = "android")]
        {
            let response: Response = self
                .handle
                .run_mobile_plugin_async(
                    "read",
                    Request {
                        origin,
                        record: None,
                    },
                )
                .await
                .map_err(|_| "STORE_ERROR".to_owned())?;
            Ok(response.record)
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("UNSUPPORTED_PLATFORM".into())
        }
    }
    pub async fn write(&self, origin: &str, record: &str) -> Result<(), String> {
        validate_origin(origin)?;
        if record.is_empty() || record.len() > 65536 {
            return Err("INVALID_RECORD".into());
        }
        #[cfg(target_os = "android")]
        {
            let _: serde::de::IgnoredAny = self
                .handle
                .run_mobile_plugin_async(
                    "write",
                    Request {
                        origin,
                        record: Some(record),
                    },
                )
                .await
                .map_err(|_| "STORE_ERROR".to_owned())?;
            Ok(())
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("UNSUPPORTED_PLATFORM".into())
        }
    }
    pub async fn delete(&self, origin: &str) -> Result<(), String> {
        validate_origin(origin)?;
        #[cfg(target_os = "android")]
        {
            let _: serde::de::IgnoredAny = self
                .handle
                .run_mobile_plugin_async(
                    "delete",
                    Request {
                        origin,
                        record: None,
                    },
                )
                .await
                .map_err(|_| "STORE_ERROR".to_owned())?;
            Ok(())
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("UNSUPPORTED_PLATFORM".into())
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aelys-session-store")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle =
                api.register_android_plugin("com.aelys.sessionstore", "SessionStorePlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            app.manage(AndroidSessionStore::<R> {
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
    use super::validate_origin;
    #[test]
    fn canonical_https_only() {
        assert!(validate_origin("https://example.com").is_ok());
        for origin in [
            "https://EXAMPLE.com",
            "https://example.com/",
            "https://example.com:443",
            "http://example.com",
            "https://user@example.com",
            "https://example.com/path",
            "https://example.com?q=1",
        ] {
            assert!(validate_origin(origin).is_err());
        }
    }
}

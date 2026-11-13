use aelys_android_updater::{Release, Source};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::sync::Mutex;

const DEFAULT_CHANNEL: &str =
    "https://github.com/DEFTileu/aelys/releases/latest/download/android-update.json";
#[derive(Default)]
pub struct UpdateState(Mutex<Pending>);
#[derive(Default)]
struct Pending {
    release: Option<Release>,
    file: Option<PathBuf>,
}
#[derive(Serialize)]
pub struct UpdateInfo {
    supported: bool,
    current_version: String,
    update: Option<Available>,
}
#[derive(Serialize)]
struct Available {
    version: String,
    size_bytes: u64,
}
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

fn source() -> Result<Source, &'static str> {
    Source::new(option_env!("AELYS_ANDROID_UPDATE_URL").unwrap_or(DEFAULT_CHANNEL))
}
fn target() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "android-aarch64",
        "arm" => "android-arm",
        "x86_64" => "android-x86_64",
        _ => "android-i686",
    }
}

#[tauri::command]
pub async fn android_update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, &'static str> {
    let current = app.package_info().version.clone();
    if !cfg!(target_os = "android") {
        return Ok(UpdateInfo {
            supported: false,
            current_version: current.to_string(),
            update: None,
        });
    }
    let mut pending = state.0.try_lock().map_err(|_| "UPDATE_BUSY")?;
    pending.release = None;
    if let Some(file) = pending.file.take() {
        let _ = tokio::fs::remove_file(file).await;
    }
    let release = source()?.check(&current.to_string(), target()).await?;
    // Tauri's default Android code is major*1_000_000 + minor*1_000 + patch.
    let code = app
        .config()
        .bundle
        .android
        .version_code
        .map(u64::from)
        .unwrap_or(current.major * 1_000_000 + current.minor * 1_000 + current.patch);
    if release.as_ref().is_some_and(|r| r.version_code <= code) {
        return Err("UPDATE_INVALID_MANIFEST");
    }
    let update = release.as_ref().map(|r| Available {
        version: r.version.clone(),
        size_bytes: r.size_bytes,
    });
    pending.release = release;
    Ok(UpdateInfo {
        supported: true,
        current_version: current.to_string(),
        update,
    })
}

#[tauri::command]
pub async fn android_update_download(
    app: AppHandle,
    state: State<'_, UpdateState>,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), &'static str> {
    if !cfg!(target_os = "android") {
        return Err("UPDATE_UNSUPPORTED");
    }
    let mut pending = state.0.try_lock().map_err(|_| "UPDATE_BUSY")?;
    let release = pending.release.clone().ok_or("UPDATE_NOT_CHECKED")?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "UPDATE_STORAGE_FAILED")?
        .join("updates");
    pending.file = None;
    let mut last = 0;
    let file = source()?
        .download(&release, &cache, |downloaded, total| {
            // Avoid flooding the WebView with one IPC message per network packet.
            if downloaded == 0
                || downloaded == total
                || downloaded.saturating_sub(last) >= 256 * 1024
            {
                let _ = on_progress.send(DownloadProgress { downloaded, total });
                last = downloaded;
            }
        })
        .await?;
    pending.file = Some(file);
    Ok(())
}

#[tauri::command]
pub async fn android_update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<&'static str, &'static str> {
    if !cfg!(target_os = "android") {
        return Err("UPDATE_UNSUPPORTED");
    }
    let pending = state.0.try_lock().map_err(|_| "UPDATE_BUSY")?;
    let release = pending.release.as_ref().ok_or("UPDATE_NOT_CHECKED")?;
    let file = pending.file.as_ref().ok_or("UPDATE_NOT_DOWNLOADED")?;
    aelys_android_updater::verify_file(file, release).await?;
    #[cfg(target_os = "android")]
    app.state::<tauri_plugin_aelys_update_verifier::UpdateVerifier<tauri::Wry>>()
        .verify(&release.version, release.version_code)
        .await?;
    launch_installer(app, file.clone()).await
}

#[cfg(target_os = "android")]
async fn launch_installer(app: AppHandle, file: PathBuf) -> Result<&'static str, &'static str> {
    use tauri_plugin_android_installer::{AndroidInstallerExt, InstallRequest};
    tauri::async_runtime::spawn_blocking(move || {
        let installer = app.android_installer();
        if !installer
            .can_install()
            .map_err(|_| "UPDATE_INSTALL_FAILED")?
        {
            installer
                .request_install_permission()
                .map_err(|_| "UPDATE_PERMISSION_REQUIRED")?;
            if !installer
                .can_install()
                .map_err(|_| "UPDATE_INSTALL_FAILED")?
            {
                return Err("UPDATE_PERMISSION_REQUIRED");
            }
        }
        installer
            .install(InstallRequest {
                path: file.to_string_lossy().into_owned(),
            })
            .map_err(|_| "UPDATE_INSTALL_FAILED")?;
        Ok("installer_opened")
    })
    .await
    .map_err(|_| "UPDATE_INSTALL_FAILED")?
}
#[cfg(not(target_os = "android"))]
async fn launch_installer(_app: AppHandle, _file: PathBuf) -> Result<&'static str, &'static str> {
    Err("UPDATE_UNSUPPORTED")
}

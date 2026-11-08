//! Native-only consent. No dialog plugin, filesystem command, shell or path
//! argument is exposed to the WebView. No security-scoped bookmark is persisted
//! and no macOS/TCC entitlement or sandbox restriction is changed here.

use super::{ReaderAdapter, Result, SessionReader};
use crate::native::NativeSessionBinding;
use aelys_runtime::paths::AuthorizedRoot;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::WebviewWindow;
use uuid::Uuid;

#[cfg(target_os = "macos")]
async fn on_main<T: Send + 'static>(
    window: &WebviewWindow,
    state: &SessionReader,
    operation: impl FnOnce(objc2::MainThreadMarker) -> Result<T> + Send + 'static,
) -> Result<T> {
    use std::sync::{atomic::Ordering, mpsc, Arc};
    struct DialogGuard(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for DialogGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    if state
        .dialog_open
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("READER_DIALOG_BUSY".into());
    }
    // The callback owns the guard: cancellation of the IPC future cannot allow
    // another dialog while this native modal is still on screen.
    let guard = DialogGuard(state.dialog_open.clone());
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .app_handle()
        .run_on_main_thread(move || {
            let _guard = guard;
            let result = objc2::MainThreadMarker::new()
                .ok_or_else(|| "READER_NATIVE_UI_UNAVAILABLE".to_string())
                .and_then(operation);
            let _ = sender.send(result);
        })
        .map_err(|_| "READER_NATIVE_UI_UNAVAILABLE".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .map_err(|_| "READER_NATIVE_UI_UNAVAILABLE".to_string())?
    })
    .await
    .map_err(|_| "READER_NATIVE_UI_UNAVAILABLE".to_string())?
}

pub(super) async fn choose(
    window: &WebviewWindow,
    state: &SessionReader,
    project_id: Uuid,
    adapter: ReaderAdapter,
    binding: &NativeSessionBinding,
) -> Result<AuthorizedRoot> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
        use objc2_foundation::NSString;
        let binding = binding.clone();
        on_main(window, state, move |mtm| {
            binding.ensure_active()?;
            let panel = NSOpenPanel::openPanel(mtm);
            panel.setCanChooseFiles(false);
            panel.setCanChooseDirectories(true);
            panel.setAllowsMultipleSelection(false);
            panel.setResolvesAliases(false);
            panel.setTitle(Some(&NSString::from_str("Aelys — local session reader")));
            panel.setPrompt(Some(&NSString::from_str("Allow local reading")));
            panel.setMessage(Some(&NSString::from_str(&format!(
                "Select only agent session storage for project {project_id}, adapter {}.\n\
                 This creates a temporary local read grant bound to your current native owner/device session.\n\
                 Transcript/FTS stay on this Mac. No upload or agent execution is authorized.\n\
                 Logout, session replacement, expiry or revoke ends access. Online checks are required.\n\
                 Revoke through session_reader_revoke or quit Aelys to discard this grant.", adapter.name()
            ))));
            if panel.runModal() != NSModalResponseOK { return Err("READER_CANCELLED".into()); }
            binding.ensure_active()?;
            let url = panel.URL().ok_or("READER_SELECTION_UNAVAILABLE")?;
            if !url.isFileURL() { return Err("READER_SELECTION_UNAVAILABLE".into()); }
            let path = url.path().ok_or("READER_SELECTION_UNAVAILABLE")?;
            let root = AuthorizedRoot::new(PathBuf::from(path.to_string()))
                .map_err(|_| "READER_ROOT_UNAVAILABLE".to_string())?;
            reject_broad_root(&root)?;
            Ok(root)
        }).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, state, project_id, adapter, binding);
        Err("READER_PLATFORM_UNAVAILABLE".into())
    }
}

#[cfg(target_os = "macos")]
fn reject_broad_root(root: &AuthorizedRoot) -> Result<()> {
    // Never infer consent to read all HOME or its ancestors. Missing HOME fails
    // closed rather than silently removing this guard. No recursive inspection.
    let home = std::env::var_os("HOME").ok_or("READER_HOME_UNAVAILABLE")?;
    let home = std::fs::canonicalize(home).map_err(|_| "READER_HOME_UNAVAILABLE")?;
    if home.starts_with(root.canonical()) {
        return Err("READER_ROOT_TOO_BROAD".into());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn confirm(
    window: &WebviewWindow,
    state: &SessionReader,
    path: PathBuf,
    project_id: Uuid,
    adapter: ReaderAdapter,
    operation: &'static str,
    binding: &NativeSessionBinding,
) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn};
        use objc2_foundation::NSString;
        let binding = binding.clone();
        on_main(window, state, move |mtm| {
            binding.ensure_active()?;
            let alert = NSAlert::new(mtm);
            alert.setMessageText(&NSString::from_str(operation));
            alert.setInformativeText(&NSString::from_str(&format!(
                "Project: {project_id}\nAdapter: {}\nSelected local root: {}\n\
                 Local read only; no upload, automation or execution permission.\n\
                 Bound to the current native owner/device session and an owner project.\n\
                 Logout/revoke ends access. This prototype has no verified OS sandbox.",
                adapter.name(),
                path.display()
            )));
            // Cancel is the default button; hitting Return cannot approve.
            alert.addButtonWithTitle(&NSString::from_str("Cancel"));
            alert.addButtonWithTitle(&NSString::from_str("Allow once"));
            if alert.runModal() == NSAlertFirstButtonReturn + 1 {
                binding.ensure_active()
            } else {
                Err("READER_CANCELLED".into())
            }
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, state, path, project_id, adapter, operation, binding);
        Err("READER_PLATFORM_UNAVAILABLE".into())
    }
}

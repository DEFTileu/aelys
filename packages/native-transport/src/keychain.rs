//! Exact-item Keychain lookups; only explicit recovery may open permission UI.
//! Background status uses attributes only; credential reads fail closed when
//! this local build lacks OS permission. No ACL, keychain or signing changes.
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use security_framework_sys::item::{
    kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecReturnAttributes,
    kSecReturnData, kSecUseAuthenticationUI,
};
use security_framework_sys::keychain::{
    SecKeychainGetUserInteractionAllowed, SecKeychainSetUserInteractionAllowed,
};
use security_framework_sys::keychain_item::SecItemCopyMatching;
use std::sync::Mutex;

static KEYCHAIN_ACCESS: Mutex<()> = Mutex::new(());

struct RestoreInteraction(u8);
impl Drop for RestoreInteraction {
    fn drop(&mut self) {
        unsafe {
            SecKeychainSetUserInteractionAllowed(self.0);
        }
    }
}
// Legacy macOS Keychain can also request permission on update/delete. The
// per-query UI flag alone does not cover these operations. Serialize every
// Aelys Keychain access, suppress implicit permission windows for its duration,
// and restore the process's prior setting (never unconditionally enable it).
fn with_interaction<T>(
    allowed: bool,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _lock = KEYCHAIN_ACCESS
        .lock()
        .map_err(|_| "STORAGE_ERROR".to_owned())?;
    let mut previous = 0;
    let status = unsafe { SecKeychainGetUserInteractionAllowed(&mut previous) };
    if status != 0 {
        return Err(status_error(status));
    }
    let status = unsafe { SecKeychainSetUserInteractionAllowed(u8::from(allowed)) };
    if status != 0 {
        return Err(status_error(status));
    }
    let _restore = RestoreInteraction(previous);
    operation()
}
fn without_ui<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    with_interaction(false, operation)
}

// Called only by the explicit, fixed-scope recovery IPC. This uses the same
// Keychain item/ACL, never rewrites data or grants access itself. The owner
// decides in the macOS prompt. Only item presence returns to the WebView.
pub fn authorize(service: &str, account: &str) -> Result<bool, String> {
    with_interaction(
        true,
        || match security_framework::passwords::get_generic_password(service, account) {
            Ok(_) => Ok(true),
            Err(error) if error.code() == NOT_FOUND => Ok(false),
            Err(error) => Err(status_error(error.code())),
        },
    )
}

pub fn write(service: &str, account: &str, bytes: &[u8]) -> Result<(), String> {
    without_ui(|| {
        security_framework::passwords::set_generic_password(service, account, bytes)
            .map_err(|error| status_error(error.code()))
    })
}
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    without_ui(
        || match security_framework::passwords::delete_generic_password(service, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == NOT_FOUND => Ok(()),
            Err(error) => Err(status_error(error.code())),
        },
    )
}

// These public Security constants are missing from the pinned sys bindings.
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecUseAuthenticationUIFail: CFStringRef;
}
const NOT_FOUND: i32 = -25300;
fn key(raw: CFStringRef) -> CFString {
    // All callers pass process-lifetime constants exported by Security.framework.
    unsafe { CFString::wrap_under_get_rule(raw) }
}
fn query(service: &str, account: &str, data: bool) -> CFDictionary<CFString, CFType> {
    unsafe {
        CFDictionary::from_CFType_pairs(&[
            (key(kSecClass), key(kSecClassGenericPassword).into_CFType()),
            (key(kSecAttrService), CFString::from(service).into_CFType()),
            (key(kSecAttrAccount), CFString::from(account).into_CFType()),
            (
                key(kSecUseAuthenticationUI),
                key(kSecUseAuthenticationUIFail).into_CFType(),
            ),
            (key(kSecReturnData), CFBoolean::from(data).into_CFType()),
            (
                key(kSecReturnAttributes),
                CFBoolean::from(!data).into_CFType(),
            ),
        ])
    }
}
pub(crate) fn status_error(status: i32) -> String {
    match status {
        // Interaction required, auth denied, user cancelled; never treat as
        // missing policy/session, which could otherwise bypass the local gate.
        -25308 | -25293 | -128 => "KEYCHAIN_ACCESS_REQUIRED",
        _ => "STORAGE_ERROR",
    }
    .into()
}
fn copy(service: &str, account: &str, data: bool) -> Result<Option<CFType>, String> {
    without_ui(|| copy_without_ui(service, account, data))
}
fn copy_without_ui(service: &str, account: &str, data: bool) -> Result<Option<CFType>, String> {
    let params = query(service, account, data);
    let mut result = std::ptr::null();
    let status = unsafe { SecItemCopyMatching(params.as_concrete_TypeRef(), &mut result) };
    // SecItemCopyMatching follows the Create rule, including unexpected output.
    let result = if result.is_null() {
        None
    } else {
        Some(unsafe { CFType::wrap_under_create_rule(result) })
    };
    match status {
        0 => result.map(Some).ok_or_else(|| "STORAGE_ERROR".into()),
        NOT_FOUND => Ok(None),
        other => Err(status_error(other)),
    }
}
pub fn exists(service: &str, account: &str) -> Result<bool, String> {
    Ok(copy(service, account, false)?.is_some())
}
pub fn read(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
    copy(service, account, true)?
        .map(|result| {
            result
                .downcast::<CFData>()
                .map(|bytes| bytes.bytes().to_vec())
                .ok_or_else(|| "STORAGE_ERROR".into())
        })
        .transpose()
}
#[cfg(test)]
mod tests {
    use super::*;
    static INTERACTION_TEST: Mutex<()> = Mutex::new(());
    #[test]
    fn interaction_guard_suppresses_and_restores_even_on_error() {
        let _serial = INTERACTION_TEST.lock().unwrap();
        let before =
            security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
                .unwrap();
        let result: Result<(), String> = without_ui(|| {
            assert!(
                !security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
                    .unwrap()
            );
            Err("KEYCHAIN_ACCESS_REQUIRED".into())
        });
        assert_eq!(result, Err("KEYCHAIN_ACCESS_REQUIRED".into()));
        assert_eq!(
            security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
                .unwrap(),
            before
        );
    }
    #[test]
    fn explicit_recovery_allows_only_scoped_interaction_then_restores() {
        let _serial = INTERACTION_TEST.lock().unwrap();
        let before =
            security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
                .unwrap();
        let result: Result<(), String> = with_interaction(true, || {
            assert!(
                security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
                    .unwrap()
            );
            Err("KEYCHAIN_ACCESS_REQUIRED".into())
        });
        assert_eq!(result, Err("KEYCHAIN_ACCESS_REQUIRED".into()));
        assert_eq!(
            security_framework::os::macos::keychain::SecKeychain::user_interaction_allowed()
                .unwrap(),
            before
        );
    }
    #[test]
    fn status_queries_never_request_credential_bytes_or_interaction() {
        let query = query("synthetic-service", "synthetic-origin", false);
        unsafe {
            assert_eq!(
                *query.get(key(kSecReturnData)),
                CFBoolean::false_value().into_CFType()
            );
            assert_eq!(
                *query.get(key(kSecReturnAttributes)),
                CFBoolean::true_value().into_CFType()
            );
            assert_eq!(
                *query.get(key(kSecUseAuthenticationUI)),
                key(kSecUseAuthenticationUIFail).into_CFType()
            );
        }
    }
    #[test]
    fn credential_queries_deny_implicit_authentication_windows() {
        let query = query("synthetic-service", "synthetic-origin", true);
        unsafe {
            assert_eq!(
                *query.get(key(kSecReturnData)),
                CFBoolean::true_value().into_CFType()
            );
            assert_eq!(
                *query.get(key(kSecReturnAttributes)),
                CFBoolean::false_value().into_CFType()
            );
            assert_eq!(
                *query.get(key(kSecUseAuthenticationUI)),
                key(kSecUseAuthenticationUIFail).into_CFType()
            );
        }
        assert_eq!(status_error(-25308), "KEYCHAIN_ACCESS_REQUIRED");
        assert_eq!(status_error(-25293), "KEYCHAIN_ACCESS_REQUIRED");
        assert_eq!(status_error(-128), "KEYCHAIN_ACCESS_REQUIRED");
        assert_eq!(status_error(-1), "STORAGE_ERROR");
    }
    #[test]
    #[ignore = "read-only local legacy Aelys policy metadata probe, no credential bytes or prompt"]
    fn local_policy_metadata_probe() {
        let result = exists("com.aelys.desktop.touch-id", "http://127.0.0.1:8000");
        println!("Aelys local policy metadata: {result:?}");
        assert!(result.is_ok() || result == Err("KEYCHAIN_ACCESS_REQUIRED".into()));
    }
}

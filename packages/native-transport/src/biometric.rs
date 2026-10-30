//! Local macOS session-unlock policy. Secrets stay in the existing OS Keychain.
#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::{extern_class, msg_send, rc::Retained, runtime::Bool};
    use objc2_foundation::{NSError, NSObject, NSString};
    use std::sync::mpsc;
    use std::time::Duration;

    const SERVICE: &str = "com.aelys.desktop.touch-id";
    // LAPolicyDeviceOwnerAuthenticationWithBiometrics, with no OS password fallback.
    const BIOMETRICS: isize = 1;
    #[link(name = "LocalAuthentication", kind = "framework")]
    unsafe extern "C" {}
    extern_class!(
        #[unsafe(super(NSObject))]
        struct LAContext;
    );
    fn context() -> Retained<LAContext> {
        // LAContext is an NSObject subclass and +new returns an owned instance.
        unsafe { msg_send![LAContext::class(), new] }
    }
    fn can_evaluate(context: &LAContext) -> bool {
        unsafe {
            let result: Bool = msg_send![context, canEvaluatePolicy: BIOMETRICS, error: std::ptr::null_mut::<*mut NSError>()];
            result.as_bool()
        }
    }
    pub fn available() -> bool {
        can_evaluate(&context())
    }
    pub fn enabled(origin: &str) -> Result<bool, String> {
        // This service only creates records for enabled policies and deletes
        // them to disable. Presence is sufficient; never decrypt the marker in
        // background status. Any existing/malformed record keeps the gate on.
        crate::keychain::exists(SERVICE, origin)
    }
    pub fn set_enabled(origin: &str, enabled: bool) -> Result<(), String> {
        if enabled {
            if crate::keychain::exists(SERVICE, origin)? {
                return Ok(());
            }
            crate::keychain::write(SERVICE, origin, b"enabled-v1")
        } else {
            crate::keychain::delete(SERVICE, origin)
        }
    }
    pub fn authenticate() -> Result<(), String> {
        let context = context();
        if !can_evaluate(&context) {
            return Err("BIOMETRIC_UNAVAILABLE".into());
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let reply = RcBlock::new(move |success: Bool, _error: *mut NSError| {
            let _ = sender.try_send(success.as_bool());
        });
        unsafe {
            let _: () = msg_send![&*context, setLocalizedFallbackTitle: &*NSString::from_str("")];
            let _: () = msg_send![&*context, evaluatePolicy: BIOMETRICS,
                localizedReason: &*NSString::from_str("Разблокировать сохранённую сессию"), reply: &*reply];
        }
        let success = receiver
            .recv_timeout(Duration::from_secs(120))
            .unwrap_or(false);
        unsafe {
            let _: () = msg_send![&*context, invalidate];
        }
        if success {
            Ok(())
        } else {
            Err("BIOMETRIC_CANCELLED".into())
        }
    }
    use objc2::ClassType;
}
#[cfg(target_os = "macos")]
pub use macos::*;
#[cfg(not(target_os = "macos"))]
pub fn available() -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn enabled(_: &str) -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(target_os = "macos"))]
pub fn set_enabled(_: &str, _: bool) -> Result<(), String> {
    Err("BIOMETRIC_UNSUPPORTED".into())
}
#[cfg(not(target_os = "macos"))]
pub fn authenticate() -> Result<(), String> {
    Err("BIOMETRIC_UNSUPPORTED".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    #[ignore = "local macOS hardware probe; never opens an authentication prompt"]
    fn touch_id_availability_probe() {
        println!("Touch ID currently available: {}", super::available());
    }
}

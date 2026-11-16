use tauri::webview::{PermissionKind, PermissionResponse};

// Wry does not expose the requesting frame or origin. Ask WebKit to prompt for
// microphone access. Deny camera and leave other requests to platform defaults.
pub(crate) fn permission_response(kind: PermissionKind) -> PermissionResponse {
    match kind {
        PermissionKind::Camera => PermissionResponse::Deny,
        _ => PermissionResponse::Default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microphone_requires_webkit_consent() {
        assert_eq!(
            permission_response(PermissionKind::Microphone),
            PermissionResponse::Default
        );
    }

    #[test]
    fn camera_is_denied() {
        assert_eq!(
            permission_response(PermissionKind::Camera),
            PermissionResponse::Deny
        );
    }

    #[test]
    fn unrelated_permissions_use_the_platform_default() {
        for kind in [PermissionKind::Geolocation, PermissionKind::Other] {
            assert_eq!(permission_response(kind), PermissionResponse::Default);
        }
    }
}

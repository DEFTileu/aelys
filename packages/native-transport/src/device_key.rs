//! Backend-compatible ES256; private bytes stay in the OS-protected native store.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    rand::SystemRandom,
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeviceKey {
    pkcs8: String,
}

impl DeviceKey {
    pub(crate) fn generate() -> Result<Self, String> {
        let value =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .map_err(|_| "DEVICE_KEY_UNAVAILABLE".to_owned())?;
        Ok(Self {
            pkcs8: URL_SAFE_NO_PAD.encode(value.as_ref()),
        })
    }
    fn key(&self) -> Result<EcdsaKeyPair, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(&self.pkcs8)
            .map_err(|_| "DEVICE_KEY_UNAVAILABLE".to_owned())?;
        EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &bytes,
            &SystemRandom::new(),
        )
        .map_err(|_| "DEVICE_KEY_UNAVAILABLE".to_owned())
    }
    pub(crate) fn public_key(&self) -> Result<String, String> {
        Ok(URL_SAFE_NO_PAD.encode(self.key()?.public_key().as_ref()))
    }
    pub(crate) fn sign(&self, message: &[u8]) -> Result<String, String> {
        let signature = self
            .key()?
            .sign(&SystemRandom::new(), message)
            .map_err(|_| "DEVICE_KEY_UNAVAILABLE".to_owned())?;
        Ok(URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_survives_protected_record_roundtrip_and_signature_is_context_bound() {
        let key = DeviceKey::generate().unwrap();
        let restored: DeviceKey =
            serde_json::from_str(&serde_json::to_string(&key).unwrap()).unwrap();
        assert_eq!(key.public_key().unwrap(), restored.public_key().unwrap());
        let message = b"aelys-device-login-v1\ndevice-id\nnonce";
        let public = URL_SAFE_NO_PAD
            .decode(restored.public_key().unwrap())
            .unwrap();
        let signature = URL_SAFE_NO_PAD
            .decode(restored.sign(message).unwrap())
            .unwrap();
        let verifier = ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            public,
        );
        verifier.verify(message, &signature).unwrap();
        assert!(verifier
            .verify(b"aelys-device-login-v1\nother-device\nnonce", &signature)
            .is_err());
    }
}

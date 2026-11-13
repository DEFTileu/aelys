//! Public release metadata and APK bytes only; never uses Aelys session credentials.
use reqwest::{Client, Response};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

pub const MAX_APK_BYTES: u64 = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone)]
pub struct Source {
    manifest: Url,
    github_repo: Option<String>,
}
impl Source {
    pub fn new(value: &str) -> Result<Self> {
        let manifest = secure_url(value).ok_or("UPDATE_INVALID_SOURCE")?;
        let github_repo = if manifest.host_str() == Some("github.com") {
            let parts: Vec<_> = manifest.path().split('/').collect();
            if parts.len() < 6
                || parts[1].is_empty()
                || parts[2].is_empty()
                || parts[3] != "releases"
            {
                return Err("UPDATE_INVALID_SOURCE");
            }
            Some(format!("/{}/{}/releases/download/", parts[1], parts[2]))
        } else {
            None
        };
        Ok(Self {
            manifest,
            github_repo,
        })
    }
    pub fn allows_artifact(&self, value: &str) -> bool {
        let Some(url) = secure_url(value) else {
            return false;
        };
        url.origin() == self.manifest.origin()
            && url.path().ends_with(".apk")
            && self
                .github_repo
                .as_ref()
                .is_none_or(|prefix| url.path().starts_with(prefix))
    }
    pub fn allows_redirect(&self, url: &Url) -> bool {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && (url.origin() == self.manifest.origin()
                || (self.github_repo.is_some()
                    && url.port_or_known_default() == Some(443)
                    && matches!(
                        url.host_str(),
                        Some(
                            "release-assets.githubusercontent.com"
                                | "objects.githubusercontent.com"
                        )
                    )))
    }
    fn client(&self) -> Result<Client> {
        let source = self.clone();
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| "UPDATE_NETWORK_FAILED")?
        .with_root_certificates(roots)
        .with_no_client_auth();
        Client::builder()
            .tls_backend_preconfigured(tls)
            .no_proxy()
            .https_only(true)
            .user_agent("Aelys-Android-Updater/1")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 || !source.allows_redirect(attempt.url()) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| "UPDATE_NETWORK_FAILED")
    }
    pub async fn check(&self, current: &str, target: &str) -> Result<Option<Release>> {
        let response = self
            .client()?
            .get(self.manifest.clone())
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| "UPDATE_NETWORK_FAILED")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err("UPDATE_CHANNEL_UNAVAILABLE");
        }
        let mut response = successful(response)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "UPDATE_NETWORK_FAILED")?
        {
            if bytes.len() + chunk.len() > MAX_MANIFEST_BYTES {
                return Err("UPDATE_INVALID_MANIFEST");
            }
            bytes.extend_from_slice(&chunk);
        }
        select_release(self, &bytes, current, target)
    }
    pub async fn download(
        &self,
        release: &Release,
        cache: &Path,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<PathBuf> {
        if !self.allows_artifact(&release.url) {
            return Err("UPDATE_INVALID_MANIFEST");
        }
        let response = self
            .client()?
            .get(&release.url)
            .send()
            .await
            .map_err(|_| "UPDATE_NETWORK_FAILED")?;
        let mut response = successful(response)?;
        if response
            .content_length()
            .is_some_and(|size| size != release.size_bytes)
        {
            return Err("UPDATE_INTEGRITY_FAILED");
        }
        let mut artifact = ArtifactWriter::new(cache, release).await?;
        progress(0, release.size_bytes);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "UPDATE_NETWORK_FAILED")?
        {
            artifact.write(&chunk).await?;
            progress(artifact.downloaded, release.size_bytes);
        }
        artifact.finish().await
    }
}
fn secure_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}
fn successful(response: Response) -> Result<Response> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err("UPDATE_NETWORK_FAILED")
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Release {
    pub version: String,
    pub version_code: u64,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
}
#[derive(Deserialize)]
struct Manifest {
    schema_version: u32,
    package_id: String,
    version: String,
    version_code: u64,
    targets: HashMap<String, Target>,
}
#[derive(Deserialize)]
struct Target {
    url: String,
    sha256: String,
    size_bytes: u64,
}

pub fn select_release(
    source: &Source,
    bytes: &[u8],
    current: &str,
    target: &str,
) -> Result<Option<Release>> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("UPDATE_INVALID_MANIFEST");
    }
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| "UPDATE_INVALID_MANIFEST")?;
    if manifest.schema_version != 1
        || manifest.package_id != "com.aelys.mobile"
        || manifest.version_code == 0
        || manifest.version_code > 2_100_000_000
    {
        return Err("UPDATE_INVALID_MANIFEST");
    }
    let version = Version::parse(&manifest.version).map_err(|_| "UPDATE_INVALID_MANIFEST")?;
    let current = Version::parse(current).map_err(|_| "UPDATE_INVALID_MANIFEST")?;
    if !version.pre.is_empty() || version <= current {
        return Ok(None);
    }
    let artifact = manifest
        .targets
        .get(target)
        .ok_or("UPDATE_TARGET_UNAVAILABLE")?;
    if !source.allows_artifact(&artifact.url)
        || artifact.size_bytes == 0
        || artifact.size_bytes > MAX_APK_BYTES
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("UPDATE_INVALID_MANIFEST");
    }
    Ok(Some(Release {
        version: manifest.version,
        version_code: manifest.version_code,
        url: artifact.url.clone(),
        sha256: artifact.sha256.to_ascii_lowercase(),
        size_bytes: artifact.size_bytes,
    }))
}
pub fn verify_artifact(bytes: &[u8], size: u64, hash: &str) -> Result<()> {
    if bytes.len() as u64 != size
        || format!("{:x}", Sha256::digest(bytes)) != hash.to_ascii_lowercase()
    {
        Err("UPDATE_INTEGRITY_FAILED")
    } else {
        Ok(())
    }
}

/// Re-read before invoking the installer; a stale/truncated cache never gets installed.
pub async fn verify_file(path: &Path, release: &Release) -> Result<()> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "UPDATE_INTEGRITY_FAILED")?;
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0u64;
    let mut hash = Sha256::new();
    loop {
        let n = file
            .read(&mut buffer)
            .await
            .map_err(|_| "UPDATE_INTEGRITY_FAILED")?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > release.size_bytes {
            return Err("UPDATE_INTEGRITY_FAILED");
        }
        hash.update(&buffer[..n]);
    }
    if size != release.size_bytes || format!("{:x}", hash.finalize()) != release.sha256 {
        return Err("UPDATE_INTEGRITY_FAILED");
    }
    Ok(())
}

/// Drops remove partial files, including when an async download is cancelled.
struct ArtifactWriter {
    file: Option<tokio::fs::File>,
    partial: PathBuf,
    final_path: PathBuf,
    release: Release,
    downloaded: u64,
    hash: Sha256,
}
static DOWNLOAD_ID: AtomicU64 = AtomicU64::new(0);
impl ArtifactWriter {
    async fn new(cache: &Path, release: &Release) -> Result<Self> {
        tokio::fs::create_dir_all(cache)
            .await
            .map_err(|_| "UPDATE_STORAGE_FAILED")?;
        let partial = cache.join(format!(
            "update-{}-{}.part",
            std::process::id(),
            DOWNLOAD_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .await
            .map_err(|_| "UPDATE_STORAGE_FAILED")?;
        Ok(Self {
            file: Some(file),
            partial,
            final_path: cache.join("aelys-update.apk"),
            release: release.clone(),
            downloaded: 0,
            hash: Sha256::new(),
        })
    }
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if self.downloaded + bytes.len() as u64 > self.release.size_bytes {
            return Err("UPDATE_INTEGRITY_FAILED");
        }
        self.file
            .as_mut()
            .ok_or("UPDATE_STORAGE_FAILED")?
            .write_all(bytes)
            .await
            .map_err(|_| "UPDATE_STORAGE_FAILED")?;
        self.downloaded += bytes.len() as u64;
        self.hash.update(bytes);
        Ok(())
    }
    async fn finish(mut self) -> Result<PathBuf> {
        if self.downloaded != self.release.size_bytes
            || format!("{:x}", self.hash.clone().finalize()) != self.release.sha256
        {
            return Err("UPDATE_INTEGRITY_FAILED");
        }
        self.file
            .as_mut()
            .ok_or("UPDATE_STORAGE_FAILED")?
            .sync_all()
            .await
            .map_err(|_| "UPDATE_STORAGE_FAILED")?;
        self.file.take();
        tokio::fs::rename(&self.partial, &self.final_path)
            .await
            .map_err(|_| "UPDATE_STORAGE_FAILED")?;
        Ok(self.final_path.clone())
    }
}
impl Drop for ArtifactWriter {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.partial);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release() -> Release {
        Release {
            version: "0.2.0".into(),
            version_code: 2000000,
            url: "https://test.invalid/app.apk".into(),
            sha256: format!("{:x}", Sha256::digest(b"abc")),
            size_bytes: 3,
        }
    }
    #[tokio::test]
    async fn streamed_files_are_only_committed_after_size_and_hash_verification() {
        let cache = std::env::temp_dir().join(format!("aelys-updater-{}", std::process::id()));
        let r = release();
        let mut a = ArtifactWriter::new(&cache, &r).await.unwrap();
        let partial = a.partial.clone();
        a.write(b"ab").await.unwrap();
        assert!(a.finish().await.is_err());
        assert!(!partial.exists());
        let mut a = ArtifactWriter::new(&cache, &r).await.unwrap();
        let partial = a.partial.clone();
        assert!(a.write(b"abcd").await.is_err());
        drop(a);
        assert!(!partial.exists());
        let mut a = ArtifactWriter::new(&cache, &r).await.unwrap();
        a.write(b"abd").await.unwrap();
        assert!(a.finish().await.is_err());
        let mut a = ArtifactWriter::new(&cache, &r).await.unwrap();
        a.write(b"a").await.unwrap();
        a.write(b"bc").await.unwrap();
        let path = a.finish().await.unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"abc");
        verify_file(&path, &r).await.unwrap();
        tokio::fs::write(&path, b"abd").await.unwrap();
        assert!(verify_file(&path, &r).await.is_err());
        tokio::fs::remove_dir_all(cache).await.unwrap();
    }
}

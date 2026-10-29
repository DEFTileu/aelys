use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::{RuntimeError, RuntimeResult};

#[derive(Debug, Clone)]
pub struct AuthorizedRoot {
    canonical: PathBuf,
}

impl AuthorizedRoot {
    pub fn new(path: impl AsRef<Path>) -> RuntimeResult<Self> {
        let path = path.as_ref();
        let metadata =
            fs::symlink_metadata(path).map_err(|e| RuntimeError::PathUnavailable(e.to_string()))?;
        if metadata.file_type().is_symlink() {
            return Err(RuntimeError::SymlinkNotAllowed);
        }
        let canonical = fs::canonicalize(path)?;
        if !canonical.is_dir() {
            return Err(RuntimeError::PathUnavailable(
                "authorized root is not a directory".into(),
            ));
        }
        Ok(Self { canonical })
    }

    pub fn canonical(&self) -> &Path {
        &self.canonical
    }

    pub fn authorize_existing(&self, candidate: impl AsRef<Path>) -> RuntimeResult<PathBuf> {
        let candidate = candidate.as_ref();
        reject_parent_components(candidate)?;
        reject_symlink_components(&self.canonical, candidate)?;
        let canonical = fs::canonicalize(candidate)?;
        if canonical == self.canonical || canonical.starts_with(&self.canonical) {
            Ok(canonical)
        } else {
            Err(RuntimeError::UnauthorizedPath)
        }
    }

    pub fn authorize_child(&self, relative: impl AsRef<Path>) -> RuntimeResult<PathBuf> {
        let relative = relative.as_ref();
        reject_parent_components(relative)?;
        self.authorize_existing(self.canonical.join(relative))
    }
}

fn reject_parent_components(path: &Path) -> RuntimeResult<()> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        Err(RuntimeError::UnauthorizedPath)
    } else {
        Ok(())
    }
}

fn reject_symlink_components(root: &Path, candidate: &Path) -> RuntimeResult<()> {
    let relative = candidate.strip_prefix(root).unwrap_or(candidate);
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if let Component::Normal(name) = component {
            current.push(name);
            if fs::symlink_metadata(&current)?.file_type().is_symlink() {
                return Err(RuntimeError::SymlinkNotAllowed);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    #[test]
    fn rejects_parent_escape() {
        let dir = tempdir().unwrap();
        let root = AuthorizedRoot::new(dir.path()).unwrap();
        assert!(matches!(
            root.authorize_child("../secret"),
            Err(RuntimeError::UnauthorizedPath)
        ));
    }

    #[test]
    fn rejects_symlink_escape() {
        let root_dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::fs::write(outside.path().join("session.jsonl"), "secret").unwrap();
        symlink(outside.path(), root_dir.path().join("link")).unwrap();
        let root = AuthorizedRoot::new(root_dir.path()).unwrap();
        assert!(matches!(
            root.authorize_child("link/session.jsonl"),
            Err(RuntimeError::SymlinkNotAllowed)
        ));
    }
}

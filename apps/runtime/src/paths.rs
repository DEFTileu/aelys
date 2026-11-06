use std::fs;
use std::path::{Component, Path, PathBuf};
#[cfg(unix)]
use std::sync::Arc;

use crate::error::{RuntimeError, RuntimeResult};

#[derive(Debug, Clone)]
pub struct AuthorizedRoot {
    canonical: PathBuf,
    #[cfg(unix)]
    directory: Arc<fs::File>,
    #[cfg(unix)]
    identity: (u64, u64),
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

        #[cfg(unix)]
        {
            use std::os::fd::FromRawFd;
            use std::os::unix::fs::MetadataExt;

            let fd = unsafe {
                libc::open(
                    c_path(&canonical)?.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(map_open_error(std::io::Error::last_os_error()));
            }
            // SAFETY: open returned a new owned descriptor.
            let directory = unsafe { fs::File::from_raw_fd(fd) };
            let opened = directory.metadata()?;
            if !opened.is_dir() || (opened.dev(), opened.ino()) != (metadata.dev(), metadata.ino())
            {
                return Err(RuntimeError::PathUnavailable(
                    "authorized root changed while it was opened".into(),
                ));
            }
            let identity = (opened.dev(), opened.ino());
            Ok(Self {
                canonical,
                directory: Arc::new(directory),
                identity,
            })
        }

        #[cfg(not(unix))]
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

    /// Reads a regular file beneath this root using descriptor-relative traversal.
    /// The relative path is never returned or opened through a joined pathname.
    pub fn read_child_bounded(
        &self,
        relative: impl AsRef<Path>,
        max_bytes: usize,
    ) -> RuntimeResult<Vec<u8>> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::MetadataExt;

            self.ensure_root_is_current()?;
            let components = relative_components(relative.as_ref())?;
            let (file, name) = self.open_parent_and_name(&components)?;
            let fd = unsafe {
                libc::openat(
                    file.as_raw_fd(),
                    c_os_str(name)?.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                )
            };
            if fd < 0 {
                return Err(map_open_error(std::io::Error::last_os_error()));
            }
            use std::os::fd::FromRawFd;
            // SAFETY: openat returned a new owned descriptor.
            let file = unsafe { fs::File::from_raw_fd(fd) };
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.dev() != self.identity.0 || metadata.nlink() != 1 {
                return Err(RuntimeError::UnauthorizedPath);
            }
            if metadata.len() > max_bytes as u64 {
                return Err(RuntimeError::UnauthorizedPath);
            }

            let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes as u64) as usize);
            let mut bounded = (&file).take(max_bytes.saturating_add(1) as u64);
            use std::io::Read;
            bounded.read_to_end(&mut bytes)?;
            if bytes.len() > max_bytes {
                return Err(RuntimeError::UnauthorizedPath);
            }
            let after = file.metadata()?;
            if (
                metadata.dev(),
                metadata.ino(),
                metadata.nlink(),
                metadata.len(),
                metadata.mtime(),
                metadata.mtime_nsec(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ) != (
                after.dev(),
                after.ino(),
                after.nlink(),
                after.len(),
                after.mtime(),
                after.mtime_nsec(),
                after.ctime(),
                after.ctime_nsec(),
            ) || bytes.len() as u64 != after.len()
            {
                return Err(RuntimeError::PathUnavailable(
                    "session changed while reading".into(),
                ));
            }
            self.ensure_root_is_current()?;
            Ok(bytes)
        }

        #[cfg(not(unix))]
        {
            let _ = (relative, max_bytes);
            Err(RuntimeError::IsolationUnavailable(
                "descriptor-bound file reads are supported only on Unix".into(),
            ))
        }
    }

    /// Namespace-only conflict check; never follows a leaf link or reads content.
    /// Any entry counts, including symlinks. This is not a filesystem snapshot.
    pub fn child_exists_no_follow(&self, relative: &Path) -> RuntimeResult<bool> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            self.ensure_root_is_current()?;
            let components = relative_components(relative)?;
            let (parent, name) = self.open_parent_and_name(&components)?;
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: parent is owned/pinned and metadata is only written here.
            let result = unsafe {
                libc::fstatat(
                    parent.as_raw_fd(),
                    c_os_str(name)?.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            let exists = if result == 0 {
                true
            } else {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ENOENT) {
                    return Err(map_open_error(error));
                }
                false
            };
            self.ensure_root_is_current()?;
            Ok(exists)
        }
        #[cfg(not(unix))]
        {
            let _ = relative;
            Err(RuntimeError::UnauthorizedPath)
        }
    }

    #[cfg(unix)]
    pub(crate) fn clone_directory_verified(&self) -> RuntimeResult<fs::File> {
        self.ensure_root_is_current()?;
        let directory = self.directory.try_clone()?;
        self.ensure_root_is_current()?;
        Ok(directory)
    }

    #[cfg(unix)]
    fn ensure_root_is_current(&self) -> RuntimeResult<()> {
        use std::os::unix::fs::MetadataExt;

        let descriptor = self.directory.metadata()?;
        let path = fs::symlink_metadata(&self.canonical)?;
        if path.file_type().is_symlink()
            || !path.is_dir()
            || (descriptor.dev(), descriptor.ino()) != self.identity
            || (path.dev(), path.ino()) != self.identity
        {
            return Err(RuntimeError::PathUnavailable(
                "authorized root was replaced".into(),
            ));
        }
        Ok(())
    }

    #[cfg(unix)]
    fn open_parent_and_name<'a>(
        &self,
        components: &'a [&'a std::ffi::OsStr],
    ) -> RuntimeResult<(fs::File, &'a std::ffi::OsStr)> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::MetadataExt;

        let (name, parents) = components
            .split_last()
            .ok_or(RuntimeError::UnauthorizedPath)?;
        let mut current = self.directory.try_clone()?;
        for component in parents {
            let fd = unsafe {
                libc::openat(
                    current.as_raw_fd(),
                    c_os_str(component)?.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ENOTDIR)
                    && descriptor_is_symlink(current.as_raw_fd(), component)?
                {
                    return Err(RuntimeError::SymlinkNotAllowed);
                }
                return Err(map_open_error(error));
            }
            // SAFETY: openat returned a new owned descriptor.
            current = unsafe { fs::File::from_raw_fd(fd) };
            if current.metadata()?.dev() != self.identity.0 {
                return Err(RuntimeError::UnauthorizedPath);
            }
        }
        Ok((current, name))
    }
}

#[cfg(unix)]
fn relative_components(path: &Path) -> RuntimeResult<Vec<&std::ffi::OsStr>> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) if name != "." => components.push(name),
            Component::CurDir => return Err(RuntimeError::UnauthorizedPath),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(RuntimeError::UnauthorizedPath)
            }
            Component::Normal(_) => return Err(RuntimeError::UnauthorizedPath),
        }
    }
    if components.is_empty() {
        Err(RuntimeError::UnauthorizedPath)
    } else {
        Ok(components)
    }
}

#[cfg(unix)]
fn c_os_str(value: &std::ffi::OsStr) -> RuntimeResult<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(value.as_bytes()).map_err(|_| RuntimeError::UnauthorizedPath)
}

#[cfg(unix)]
fn c_path(value: &Path) -> RuntimeResult<std::ffi::CString> {
    c_os_str(value.as_os_str())
}

#[cfg(unix)]
fn map_open_error(error: std::io::Error) -> RuntimeError {
    if error.raw_os_error() == Some(libc::ELOOP) {
        RuntimeError::SymlinkNotAllowed
    } else {
        RuntimeError::PathUnavailable(error.to_string())
    }
}

#[cfg(unix)]
fn descriptor_is_symlink(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::OsStr,
) -> RuntimeResult<bool> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            directory_fd,
            c_os_str(name)?.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Ok(false);
    }
    let metadata = unsafe { metadata.assume_init() };
    Ok((metadata.st_mode & libc::S_IFMT) == libc::S_IFLNK)
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

    #[test]
    fn reads_regular_child_within_limit() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        std::fs::write(dir.path().join("nested/session.jsonl"), b"session data").unwrap();
        let root = AuthorizedRoot::new(dir.path()).unwrap();

        assert_eq!(
            root.read_child_bounded("nested/session.jsonl", 12).unwrap(),
            b"session data"
        );
    }

    #[test]
    fn rejects_traversal_absolute_and_empty_paths() {
        let dir = tempdir().unwrap();
        let root = AuthorizedRoot::new(dir.path()).unwrap();

        for path in [
            Path::new("../secret"),
            Path::new("/etc/passwd"),
            Path::new(""),
        ] {
            assert!(matches!(
                root.read_child_bounded(path, 1024),
                Err(RuntimeError::UnauthorizedPath)
            ));
        }
    }

    #[test]
    fn rejects_symlinks_in_intermediate_and_final_components() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"secret").unwrap();
        std::fs::write(dir.path().join("target"), b"target").unwrap();
        symlink(outside.path(), dir.path().join("linked-dir")).unwrap();
        symlink("target", dir.path().join("linked-file")).unwrap();
        let root = AuthorizedRoot::new(dir.path()).unwrap();

        assert!(matches!(
            root.read_child_bounded("linked-dir/secret", 100),
            Err(RuntimeError::SymlinkNotAllowed)
        ));
        assert!(matches!(
            root.read_child_bounded("linked-file", 100),
            Err(RuntimeError::SymlinkNotAllowed)
        ));
    }

    #[test]
    fn rejects_hard_links_to_files_outside_the_selected_root() {
        let parent = tempdir().unwrap();
        let root_path = parent.path().join("root");
        fs::create_dir(&root_path).unwrap();
        let outside = parent.path().join("outside");
        fs::write(&outside, b"private").unwrap();
        fs::hard_link(&outside, root_path.join("linked.jsonl")).unwrap();
        let root = AuthorizedRoot::new(&root_path).unwrap();
        assert!(matches!(
            root.read_child_bounded("linked.jsonl", 100),
            Err(RuntimeError::UnauthorizedPath)
        ));
    }

    #[test]
    fn rejects_directory_nonregular_file_and_oversize_file() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();
        std::fs::write(dir.path().join("large"), b"12345").unwrap();
        let fifo = dir.path().join("pipe");
        let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        let root = AuthorizedRoot::new(dir.path()).unwrap();

        for path in ["subdir", "pipe", "large"] {
            assert!(matches!(
                root.read_child_bounded(path, 4),
                Err(RuntimeError::UnauthorizedPath)
            ));
        }
    }

    #[test]
    fn root_replacement_fails_closed() {
        let parent = tempdir().unwrap();
        let root_path = parent.path().join("authorized");
        std::fs::create_dir(&root_path).unwrap();
        std::fs::write(root_path.join("file"), b"original").unwrap();
        let root = AuthorizedRoot::new(&root_path).unwrap();

        std::fs::rename(&root_path, parent.path().join("moved")).unwrap();
        std::fs::create_dir(&root_path).unwrap();
        std::fs::write(root_path.join("file"), b"replacement").unwrap();

        assert!(matches!(
            root.read_child_bounded("file", 100),
            Err(RuntimeError::PathUnavailable(_))
        ));
    }
}

//! Phase 5 / task 2: local, bounded discovery, without vendor-path inference.
//!
//! Keep one SessionDiscovery alive across pages. A page is owned by the caller:
//! retain/retry its unattempted candidates before requesting the next page.
//! Dropping the walker loses continuation; restart a full pass (indexing replay
//! is safe). No timestamps, offsets, revision cache, persisted cursors, watchers,
//! cloud writes or deletion inference. Backup/egress decisions remain OPEN.
//!
//! Limits bound entries, candidates, path length, depth and open descriptors,
//! not filesystem syscall latency. Directory order is native and unsorted;
//! stable trees are visited once, live changes require another full pass.
//! Exhaustion is NOT a filesystem snapshot or evidence for tombstones.
//!
//! macOS/Linux only; other platforms fail closed. Traversal uses no-follow
//! descriptor-relative opens and metadata. Different-device mounts are skipped;
//! hard links, same-device mounts and hostile concurrent renames are not an OS
//! sandbox. Candidate reads MUST still use the indexing coordinator.
//!
//! Root acquisition uses AuthorizedRoot::clone_directory_verified: never reopen
//! the root pathname. Namespace validation happens at page boundaries as well.
//! No atomic snapshot claim is made for concurrent directory/content mutation.

use std::path::PathBuf;

use crate::paths::AuthorizedRoot;
use crate::{RuntimeError, RuntimeResult};

#[derive(Debug, Clone, Copy)]
pub struct DiscoveryLimits {
    pub max_files: usize,
    /// Includes filtered, rejected and non-regular entries, not just matches.
    pub max_entries: usize,
    /// Root depth is zero; maximum 63 keeps candidates within indexing's 64 components.
    pub max_depth: usize,
    pub max_file_bytes: u64,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            max_files: 32,
            max_entries: 1024,
            max_depth: 63,
            max_file_bytes: 4 * 1024 * 1024,
        }
    }
}

impl DiscoveryLimits {
    fn validate(self) -> RuntimeResult<()> {
        if self.max_files == 0
            || self.max_files > 1024
            || self.max_entries == 0
            || self.max_entries > 65_536
            || self.max_depth > 63
            || self.max_file_bytes == 0
            || self.max_file_bytes > 8 * 1024 * 1024
        {
            return Err(unavailable("invalid session discovery limits"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryState {
    /// Continue using the same walker, including when this page is empty.
    More,
    Exhausted,
    /// Some subtrees/files were not inspectable within the configured limits.
    /// Skips are per page; this flag remembers omissions in earlier pages too.
    ExhaustedWithOmissions,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DiscoverySkips {
    pub filtered: usize,
    pub symlinks: usize,
    pub non_regular: usize,
    pub oversized: usize,
    pub depth_limited: usize,
    pub path_limited: usize,
    pub unavailable: usize,
    pub cross_device_or_cycle: usize,
}

pub struct DiscoveryPage {
    /// Local-only, normalized relative paths accepted by index_batch.
    /// No content, metadata revision or mtime watermark is inferred here.
    pub candidates: Vec<PathBuf>,
    pub entries_visited: usize,
    /// Entry attempts plus EOF/rejected-directory steps; <= max_entries.
    pub work_units: usize,
    pub skipped: DiscoverySkips,
    pub state: DiscoveryState,
    pub(super) observations: Vec<(chrono::DateTime<chrono::Utc>, u64)>,
}

// Do not leak local paths through routine diagnostic formatting.
impl std::fmt::Debug for DiscoveryPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiscoveryPage")
            .field("candidate_count", &self.candidates.len())
            .field("entries_visited", &self.entries_visited)
            .field("work_units", &self.work_units)
            .field("skipped", &self.skipped)
            .field("state", &self.state)
            .finish()
    }
}

fn unavailable(reason: &'static str) -> RuntimeError {
    RuntimeError::AdapterUnavailable(reason.into())
}

pub struct SessionDiscovery {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    walk: native::Walk,
}

impl SessionDiscovery {
    /// Explicitly supplied root only. Empty extensions permits any regular
    /// file; otherwise suffixes (including `jsonl.zst`) are case-insensitive.
    /// Compound suffixes are opt-in; `zst` is not inferred from `jsonl`.
    pub fn new(
        root: &AuthorizedRoot,
        extensions: &[&str],
        limits: DiscoveryLimits,
    ) -> RuntimeResult<Self> {
        limits.validate()?;
        if extensions.len() > 32
            || extensions.iter().any(|s| {
                s.is_empty()
                    || s.len() > 32
                    || s.split('.').any(|part| {
                        part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric())
                    })
            })
        {
            return Err(unavailable("invalid session discovery extensions"));
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            Ok(Self {
                walk: native::Walk::new(root, extensions, limits)?,
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = root;
            Err(unavailable(
                "descriptor discovery is unavailable on this platform",
            ))
        }
    }

    /// Fatal root errors invalidate continuation; restart a full pass after
    /// fixing authorization. Files changed after discovery are reauthorized
    /// and read with byte limits by the coordinator, never by this walker.
    pub fn next_page(&mut self) -> RuntimeResult<DiscoveryPage> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            self.walk.next_page()
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        Err(unavailable(
            "descriptor discovery is unavailable on this platform",
        ))
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod native {
    use super::*;
    use std::ffi::{CStr, CString, OsStr, OsString};
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::MetadataExt;
    use std::path::Component;
    use std::ptr::NonNull;

    const DIRECTORY_FLAGS: i32 =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

    // DIR owns its fd; no dup/shared seek offset and no unbounded read_dir collect.
    struct Directory {
        stream: NonNull<libc::DIR>,
        relative: PathBuf,
        identity: (u64, u64),
    }

    impl Directory {
        fn new(file: File, relative: PathBuf) -> std::io::Result<Self> {
            let metadata = file.metadata()?;
            let fd = file.into_raw_fd();
            // SAFETY: fd is owned and refers to an opened directory.
            let stream = unsafe { libc::fdopendir(fd) };
            match NonNull::new(stream) {
                Some(stream) => Ok(Self {
                    stream,
                    relative,
                    identity: (metadata.dev(), metadata.ino()),
                }),
                None => {
                    let error = std::io::Error::last_os_error();
                    // SAFETY: fdopendir did not take ownership on failure.
                    drop(unsafe { File::from_raw_fd(fd) });
                    Err(error)
                }
            }
        }

        fn fd(&self) -> RawFd {
            // SAFETY: stream is live until Drop.
            unsafe { libc::dirfd(self.stream.as_ptr()) }
        }

        fn next_name(&mut self) -> std::io::Result<Option<OsString>> {
            loop {
                // SAFETY: errno is thread-local; stream is owned exclusively.
                let entry = unsafe {
                    *errno() = 0;
                    libc::readdir(self.stream.as_ptr())
                };
                if entry.is_null() {
                    let error = std::io::Error::last_os_error();
                    return if error.raw_os_error() == Some(0) {
                        Ok(None)
                    } else {
                        Err(error)
                    };
                }
                // SAFETY: readdir's name is NUL-terminated and copied before reuse.
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
                if name != b"." && name != b".." {
                    return Ok(Some(OsString::from_vec(name.to_vec())));
                }
            }
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            // SAFETY: this is the sole owner of the stream and its fd.
            unsafe { libc::closedir(self.stream.as_ptr()) };
        }
    }

    unsafe fn errno() -> *mut libc::c_int {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::__error()
        }
        #[cfg(target_os = "linux")]
        unsafe {
            libc::__errno_location()
        }
    }

    fn open_dir_at(fd: RawFd, name: &OsStr) -> std::io::Result<File> {
        let name = CString::new(name.as_bytes())?;
        // SAFETY: CString lives through the call; returned fd has sole ownership.
        let opened = unsafe { libc::openat(fd, name.as_ptr(), DIRECTORY_FLAGS) };
        if opened < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(opened) })
        }
    }

    pub(super) struct Walk {
        root: AuthorizedRoot,
        anchor: File,
        stack: Vec<Directory>,
        extensions: Vec<String>,
        limits: DiscoveryLimits,
        omissions: bool,
        failed: bool,
    }

    impl Walk {
        pub(super) fn new(
            root: &AuthorizedRoot,
            extensions: &[&str],
            limits: DiscoveryLimits,
        ) -> RuntimeResult<Self> {
            if !root.canonical().is_absolute()
                || root.canonical().as_os_str().len() > 4096
                || root.canonical().to_str().is_none()
                || root.canonical().components().count() > 64
            {
                return Err(RuntimeError::UnauthorizedPath);
            }
            let anchor = root
                .clone_directory_verified()
                .map_err(|_| unavailable("session discovery root cannot be opened"))?;
            let directory = Directory::new(
                open_dir_at(anchor.as_raw_fd(), OsStr::new("."))?,
                PathBuf::new(),
            )?;
            let walk = Self {
                root: root.clone(),
                anchor,
                stack: vec![directory],
                extensions: extensions.iter().map(|s| s.to_ascii_lowercase()).collect(),
                limits,
                omissions: false,
                failed: false,
            };
            walk.check_root()?;
            Ok(walk)
        }

        fn check_root(&self) -> RuntimeResult<()> {
            let current = self
                .root
                .clone_directory_verified()
                .map_err(|_| unavailable("session discovery root changed; restart required"))?;
            let a = self.anchor.metadata()?;
            let b = current.metadata()?;
            if (a.dev(), a.ino()) != (b.dev(), b.ino()) {
                return Err(unavailable(
                    "session discovery root changed; restart required",
                ));
            }
            Ok(())
        }

        // Reopen from the anchor, never through an earlier saved pathname.
        // Reject a renamed/replaced/symlinked subtree before resuming its stream.
        fn directory_is_current(&self, directory: &Directory) -> bool {
            let mut current = match open_dir_at(self.anchor.as_raw_fd(), OsStr::new(".")) {
                Ok(file) => file,
                Err(_) => return false,
            };
            for name in directory.relative.components() {
                let Component::Normal(name) = name else {
                    return false;
                };
                current = match open_dir_at(current.as_raw_fd(), name) {
                    Ok(file) => file,
                    Err(_) => return false,
                };
            }
            current
                .metadata()
                .is_ok_and(|m| (m.dev(), m.ino()) == directory.identity)
        }

        pub(super) fn next_page(&mut self) -> RuntimeResult<DiscoveryPage> {
            if self.failed {
                return Err(unavailable(
                    "session discovery continuation invalid; restart required",
                ));
            }
            let result = self.page();
            if result.is_err() {
                self.failed = true;
                self.stack.clear();
            }
            result
        }

        fn page(&mut self) -> RuntimeResult<DiscoveryPage> {
            self.check_root()?;
            let mut page = DiscoveryPage {
                candidates: Vec::new(),
                entries_visited: 0,
                work_units: 0,
                skipped: DiscoverySkips::default(),
                state: DiscoveryState::More,
                observations: Vec::new(),
            };
            // Invalid frames and EOF also consume work. Thus a tiny page budget
            // cannot hide unbounded empty/unreadable-directory traversal.
            let mut work = 0;
            while !self.stack.is_empty()
                && work < self.limits.max_entries
                && page.candidates.len() < self.limits.max_files
            {
                work += 1;
                if !self.directory_is_current(self.stack.last().unwrap()) {
                    self.stack.pop();
                    page.skipped.unavailable += 1;
                    self.omissions = true;
                    continue;
                }
                let directory_depth = self.stack.len() - 1;
                let directory = self.stack.last_mut().unwrap();
                let name = match directory.next_name() {
                    Ok(Some(name)) => name,
                    end => {
                        if end.is_err() {
                            page.skipped.unavailable += 1;
                            self.omissions = true;
                        }
                        self.stack.pop();
                        continue;
                    }
                };
                page.entries_visited += 1;
                let relative = directory.relative.join(&name);
                if relative.as_os_str().len() > 4096 || relative.to_str().is_none() {
                    page.skipped.path_limited += 1;
                    self.omissions = true;
                    continue;
                }
                let c_name = CString::new(name.as_bytes()).expect("directory names have no NUL");
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                // SAFETY: stat is initialized only on success; never follows leaf links.
                if unsafe {
                    libc::fstatat(
                        directory.fd(),
                        c_name.as_ptr(),
                        stat.as_mut_ptr(),
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                } != 0
                {
                    page.skipped.unavailable += 1;
                    self.omissions = true;
                    continue;
                }
                let stat = unsafe { stat.assume_init() };
                let kind = stat.st_mode & libc::S_IFMT;
                if kind == libc::S_IFLNK {
                    page.skipped.symlinks += 1;
                } else if stat.st_dev as u64 != self.anchor.metadata()?.dev() {
                    page.skipped.cross_device_or_cycle += 1;
                    self.omissions = true;
                } else if kind == libc::S_IFDIR {
                    if directory_depth >= self.limits.max_depth {
                        page.skipped.depth_limited += 1;
                        self.omissions = true;
                        continue;
                    }
                    let child = open_dir_at(directory.fd(), &name)
                        .and_then(|f| Directory::new(f, relative));
                    match child {
                        Ok(child)
                            if child.identity == (stat.st_dev as u64, stat.st_ino)
                                && !self.stack.iter().any(|d| d.identity == child.identity) =>
                        {
                            self.stack.push(child);
                        }
                        _ => {
                            page.skipped.unavailable += 1;
                            self.omissions = true;
                        }
                    }
                } else if kind != libc::S_IFREG {
                    page.skipped.non_regular += 1;
                } else if !self.extensions.is_empty()
                    && !relative
                        .file_name()
                        .and_then(|s| s.to_str())
                        .is_some_and(|name| {
                            self.extensions.iter().any(|allowed| {
                                name.to_ascii_lowercase().ends_with(&format!(".{allowed}"))
                            })
                        })
                {
                    page.skipped.filtered += 1;
                } else if stat.st_size < 0 || stat.st_size as u64 > self.limits.max_file_bytes {
                    page.skipped.oversized += 1;
                    self.omissions = true;
                } else {
                    let Some(modified) =
                        chrono::DateTime::from_timestamp(stat.st_mtime, stat.st_mtime_nsec as u32)
                    else {
                        page.skipped.unavailable += 1;
                        self.omissions = true;
                        continue;
                    };
                    page.candidates.push(relative);
                    page.observations.push((modified, stat.st_size as u64));
                }
            }
            page.work_units = work;
            self.check_root()?;
            if self.stack.is_empty() {
                page.state = if self.omissions {
                    DiscoveryState::ExhaustedWithOmissions
                } else {
                    DiscoveryState::Exhausted
                };
            }
            Ok(page)
        }
    }
}

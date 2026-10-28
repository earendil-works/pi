//! File operations with Node's semantics where the Rust standard library differs (docs/semantics.md).

use crate::errors::Failure;
use crate::sys;
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::Path;

pub type Outcome<T> = Result<T, Failure>;

/// `{ name, kind, size, mtimeSec, mtimeNsec, dev, ino }` of lstat or fstat metadata.
pub fn info(path: &str, metadata: &Metadata) -> Value {
    let file_type = metadata.file_type();
    let kind = if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    };
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (mtime_sec, mtime_nsec) = sys::mtime(metadata);
    let (dev, ino) = sys::identity(metadata);
    json!({
        "name": name,
        "kind": kind,
        "size": metadata.len(),
        "mtimeSec": mtime_sec,
        "mtimeNsec": mtime_nsec,
        "dev": dev,
        "ino": ino,
    })
}

pub fn lstat(path: &str) -> Outcome<Value> {
    fs::symlink_metadata(path)
        .map(|metadata| info(path, &metadata))
        .map_err(|error| Failure::io(&error, "lstat", path))
}

pub fn realpath(path: &str) -> Outcome<Value> {
    sys::realpath(path)
        .map(|resolved| json!({ "path": resolved }))
        .map_err(|error| Failure::io(&error, "realpath", path))
}

/// Node's recursive `mkdir`: an existing directory is fine, an existing file is `EEXIST`, a file in the way of a
/// parent is `ENOTDIR`.
pub fn mkdir_recursive(path: &Path) -> io::Result<()> {
    let is_dir = |path: &Path| {
        fs::metadata(path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
    };
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if is_dir(path) {
                Ok(())
            } else {
                Err(error)
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            else {
                return Err(error);
            };
            match mkdir_recursive(parent) {
                Err(parent_error) if parent_error.kind() == io::ErrorKind::AlreadyExists => {
                    return Err(sys::synthetic("ENOTDIR"));
                }
                other => other?,
            }
            match fs::create_dir(path) {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists && is_dir(path) => {
                    Ok(())
                }
                other => other,
            }
        }
        Err(error) => Err(error),
    }
}

pub fn mkdir(path: &str, recursive: bool) -> Outcome<Value> {
    let result = if recursive {
        mkdir_recursive(Path::new(path))
    } else {
        fs::create_dir(path)
    };
    result
        .map(|()| json!({}))
        .map_err(|error| Failure::io(&error, "mkdir", path))
}

/// `writeFile`/`appendFile`: create missing parents like Node's recursive `mkdir`, then write. Returns the open file
/// for further chunks.
pub fn write(path: &str, append: bool, parents: bool, content: &[u8]) -> Outcome<File> {
    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|_| parents)
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        mkdir_recursive(parent)
            .map_err(|error| Failure::io(&error, "mkdir", &parent.to_string_lossy()))?;
    }
    let mode = if append {
        sys::OpenMode::Append
    } else {
        sys::OpenMode::Write
    };
    let mut file = sys::open(path, mode).map_err(|error| Failure::io(&error, "open", path))?;
    file.write_all(content)
        .map_err(|error| Failure::io(&error, "write", path))?;
    Ok(file)
}

fn open_existing_for_write(path: &str) -> Outcome<File> {
    sys::open(path, sys::OpenMode::ReadWrite).map_err(|error| Failure::io(&error, "open", path))
}

pub fn truncate(path: &str, size: u64) -> Outcome<Value> {
    let file = open_existing_for_write(path)?;
    file.set_len(size)
        .map_err(|error| Failure::io(&error, "ftruncate", path))?;
    Ok(json!({}))
}

pub fn fsync(path: &str) -> Outcome<Value> {
    // POSIX refuses to open a directory for writing; check first so Windows reports the same.
    if fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(Failure::new(
            "EISDIR",
            format!("EISDIR: illegal operation on a directory, open '{path}'"),
        )
        .path(path));
    }
    let file = open_existing_for_write(path)?;
    file.sync_all()
        .map_err(|error| Failure::io(&error, "fsync", path))?;
    Ok(json!({}))
}

pub fn rename(from: &str, to: &str) -> Outcome<Value> {
    sys::rename(from, to)
        .map(|()| json!({}))
        .map_err(|error| Failure::io_between(&error, "rename", from, Some(to)))
}

/// Node's `fs.rm`: missing paths fail unless `force`; a directory without `recursive` fails with `ERR_FS_EISDIR`.
pub fn rm(path: &str, recursive: bool, force: bool) -> Outcome<Value> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(Failure::io(&error, "lstat", path)),
    };
    let result = if metadata.is_dir() {
        if !recursive {
            return Err(Failure::new(
                "ERR_FS_EISDIR",
                format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
            )
            .path(path));
        }
        fs::remove_dir_all(path)
    } else {
        sys::remove_file(path)
    };
    result
        .map(|()| json!({}))
        .map_err(|error| Failure::io(&error, "rm", path))
}

/// A new directory named `prefix` plus six random characters, as libuv's `mkdtemp` creates it.
pub fn mkdtemp(prefix: &str) -> Outcome<Value> {
    sys::mkdtemp(prefix)
        .map(|path| json!({ "path": path }))
        .map_err(|error| Failure::io(&error, "mkdtemp", &format!("{prefix}XXXXXX")))
}

/// Open a regular file for positional reads; directories fail with `EISDIR`, other non-regular files with
/// `NOT_REGULAR`, and with `no_follow` a final symbolic link with `SYMLINK`.
pub fn open_reader(path: &str, no_follow: bool) -> Outcome<(File, Value)> {
    let file = sys::open_reader(path, no_follow)?;
    let metadata = file
        .metadata()
        .map_err(|error| Failure::io(&error, "fstat", path))?;
    if metadata.is_dir() {
        return Err(
            Failure::new("EISDIR", "EISDIR: illegal operation on a directory, read").path(path),
        );
    }
    if !metadata.is_file() {
        return Err(Failure::new("NOT_REGULAR", "Not a regular file").path(path));
    }
    let info = info(path, &metadata);
    Ok((file, info))
}

/// Up to `length` bytes at `offset`; fewer only at the end of the file.
pub fn pread(file: &File, path: &str, offset: u64, length: usize) -> Outcome<Vec<u8>> {
    let mut buffer = vec![0u8; length];
    let mut filled = 0;
    while filled < length {
        match sys::read_at(file, &mut buffer[filled..], offset + filled as u64) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(Failure::io(&error, "read", path)),
        }
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// Up to `length` bytes from the current position: one `read` call, as Node's `readFile` makes for files of unknown
/// size (FIFOs, devices).
pub fn read(mut file: &File, path: &str, length: usize) -> Outcome<Vec<u8>> {
    let mut buffer = vec![0u8; length];
    loop {
        match file.read(&mut buffer) {
            Ok(read) => {
                buffer.truncate(read);
                return Ok(buffer);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(Failure::io(&error, "read", path)),
        }
    }
}

/// One directory entry as Node lists it: the name decoded as UTF-8 (invalid bytes replaced), and lstat of the
/// directory joined with that decoded name, so a name that is not valid UTF-8 reports `ENOENT` as in Node. `raw`
/// carries the original bytes of such a name, which libuv sorts by.
pub fn dir_entry(dir: &str, file_name: &OsStr) -> Value {
    let name = file_name.to_string_lossy().into_owned();
    let entry_path = Path::new(dir).join(&name).to_string_lossy().into_owned();
    let mut entry = match fs::symlink_metadata(&entry_path) {
        Ok(metadata) => json!({ "name": name, "info": info(&entry_path, &metadata) }),
        Err(error) => {
            json!({ "name": name, "error": Failure::io(&error, "lstat", &entry_path).to_json() })
        }
    };
    if let Some(raw) = sys::raw_name(file_name).filter(|raw| *raw != name.as_bytes()) {
        entry["raw"] = json!(raw);
    }
    entry
}

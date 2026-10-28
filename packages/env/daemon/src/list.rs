//! `listFiles`: the files and directories below a directory, as `fd --hidden --exclude .git` lists them (without
//! following symbolic links), skipping what git ignores. Uses the `ignore` crate, which fd and ripgrep use.

use crate::errors::Failure;
use crate::frame::MAX_PAYLOAD;
use ignore::WalkBuilder;
use serde_json::{Value, json};
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path};
use std::time::{Duration, Instant};

const DEFAULT_MAX_ENTRIES: u64 = 50_000;
const DEFAULT_MAX_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;

pub struct Options {
    /// Include names starting with `.` (and, on Windows, hidden files).
    pub hidden: bool,
    /// Skip what git ignores inside git work trees: `.gitignore` files, `.git/info/exclude`, the global excludes file.
    pub gitignore: bool,
    /// Names skipped with everything below them, in addition to `.git`.
    pub exclude: Vec<OsString>,
    pub max_entries: u64,
    /// Bytes of the listing payload: per entry one kind byte, the path, and a NUL.
    pub max_bytes: u64,
    pub timeout: Duration,
}

impl Options {
    pub fn from_json(json: &Value) -> Result<Options, Failure> {
        let count = |key: &str, default: u64| -> Result<u64, Failure> {
            match &json[key] {
                Value::Null => Ok(default),
                value => value
                    .as_u64()
                    .ok_or_else(|| Failure::new("EINVAL", format!("invalid field {key}"))),
            }
        };
        let exclude = match &json["exclude"] {
            Value::Null => Vec::new(),
            Value::Array(names) => names
                .iter()
                .map(|name| name.as_str().map(OsString::from))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| Failure::new("EINVAL", "invalid field exclude"))?,
            _ => return Err(Failure::new("EINVAL", "invalid field exclude")),
        };
        Ok(Options {
            hidden: json["hidden"].as_bool().unwrap_or(true),
            gitignore: json["gitignore"].as_bool().unwrap_or(true),
            exclude,
            max_entries: count("maxEntries", DEFAULT_MAX_ENTRIES)?,
            max_bytes: count("maxBytes", DEFAULT_MAX_BYTES)?.min(MAX_PAYLOAD as u64),
            timeout: Duration::from_millis(count("timeoutMs", DEFAULT_TIMEOUT_MS)?),
        })
    }
}

pub struct Listing {
    /// Records of a kind byte (`f`, `d`, `l`), the path relative to the root with `/` separators, and a NUL.
    pub payload: Vec<u8>,
    pub count: u64,
    pub truncated: bool,
}

/// The path of `path` below `root`, its components joined with `/`; names that are not UTF-8 get replacement
/// characters, as `readdir` reports them.
fn relative(root: &Path, path: &Path) -> Option<String> {
    let rest = path.strip_prefix(root).ok()?;
    let mut text = String::new();
    for component in rest.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        if !text.is_empty() {
            text.push('/');
        }
        text.push_str(&name.to_string_lossy());
    }
    (!text.is_empty()).then_some(text)
}

/// List `root` depth first, siblings in byte order of their names. Stops with `truncated` at the first entry beyond
/// a bound; fails with `aborted` once `aborted()` is true. Entries that cannot be read are skipped.
pub fn list(root: &str, options: &Options, aborted: &dyn Fn() -> bool) -> Result<Listing, Failure> {
    let metadata = fs::metadata(root).map_err(|error| Failure::io(&error, "scandir", root))?;
    if !metadata.is_dir() {
        return Err(Failure::new(
            "ENOTDIR",
            format!("ENOTDIR: not a directory, scandir '{root}'"),
        )
        .path(root));
    }
    let root_path = Path::new(root);
    let exclude = options.exclude.clone();
    let walk = WalkBuilder::new(root_path)
        .hidden(!options.hidden)
        .ignore(false)
        .parents(options.gitignore)
        .git_ignore(options.gitignore)
        .git_exclude(options.gitignore)
        .git_global(options.gitignore)
        .require_git(true)
        .follow_links(false)
        // The global excludes file is found relative to the listed directory, not the daemon's.
        .current_dir(root_path)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(move |entry| {
            let name = entry.file_name();
            name != ".git" && !exclude.iter().any(|excluded| excluded == name)
        })
        .build();
    let started = Instant::now();
    let mut listing = Listing {
        payload: Vec::new(),
        count: 0,
        truncated: false,
    };
    for entry in walk {
        if aborted() {
            return Err(Failure::new("aborted", "aborted"));
        }
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        let kind = if file_type.is_symlink() {
            b'l'
        } else if file_type.is_dir() {
            b'd'
        } else if file_type.is_file() {
            b'f'
        } else {
            continue;
        };
        let Some(path) = relative(root_path, entry.path()) else {
            continue;
        };
        let size = path.len() as u64 + 2;
        if listing.count >= options.max_entries
            || listing.payload.len() as u64 + size > options.max_bytes
            || started.elapsed() > options.timeout
        {
            listing.truncated = true;
            break;
        }
        listing.payload.push(kind);
        listing.payload.extend_from_slice(path.as_bytes());
        listing.payload.push(0);
        listing.count += 1;
    }
    Ok(listing)
}

pub fn run(json: &Value, aborted: &dyn Fn() -> bool) -> Result<(Value, Vec<u8>), Failure> {
    let root = json["path"]
        .as_str()
        .ok_or_else(|| Failure::new("EINVAL", "missing field path"))?;
    let listing = list(root, &Options::from_json(json)?, aborted)?;
    Ok((
        json!({ "count": listing.count, "truncated": listing.truncated }),
        listing.payload,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Tree(std::path::PathBuf);

    impl Tree {
        fn new(files: &[&str]) -> Tree {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "pi-env-list-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let tree = Tree(root);
            for file in files {
                tree.write(file, "");
            }
            tree
        }

        fn write(&self, path: &str, content: &str) {
            let path = self.0.join(path);
            if path.to_string_lossy().ends_with('/') {
                fs::create_dir_all(&path).unwrap();
                return;
            }
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn list(&self, options: Options) -> (Vec<String>, bool) {
            let listing = list(&self.0.to_string_lossy(), &options, &|| false).unwrap();
            let entries: Vec<String> = listing
                .payload
                .split(|byte| *byte == 0)
                .filter(|record| !record.is_empty())
                .map(|record| {
                    format!(
                        "{} {}",
                        record[0] as char,
                        String::from_utf8_lossy(&record[1..])
                    )
                })
                .collect();
            assert_eq!(entries.len() as u64, listing.count);
            (entries, listing.truncated)
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn options() -> Options {
        Options::from_json(&json!({})).unwrap()
    }

    #[test]
    fn lists_files_and_directories_depth_first_in_name_order() {
        let tree = Tree::new(&[
            "b.txt",
            "a/z.txt",
            "a/b/c.txt",
            "empty/",
            ".hidden/x",
            "A.txt",
        ]);
        let (entries, truncated) = tree.list(options());
        assert_eq!(
            entries,
            [
                "d .hidden",
                "f .hidden/x",
                "f A.txt",
                "d a",
                "d a/b",
                "f a/b/c.txt",
                "f a/z.txt",
                "f b.txt",
                "d empty"
            ]
        );
        assert!(!truncated);
        let (entries, _) = tree.list(Options {
            hidden: false,
            ..options()
        });
        assert!(!entries.iter().any(|entry| entry.contains(".hidden")));
    }

    #[test]
    fn skips_what_git_ignores_only_in_work_trees() {
        let tree = Tree::new(&[
            "keep.txt",
            "out/x.js",
            "sub/keep.txt",
            "sub/drop.log",
            "node_modules/m/i.js",
        ]);
        tree.write(".gitignore", "out/\n*.log\n");
        tree.write("sub/.gitignore", "!keep.txt\n");
        // Not a work tree yet: everything is listed.
        let (entries, _) = tree.list(options());
        assert!(entries.contains(&"f out/x.js".to_string()));
        tree.write(".git/HEAD", "ref: refs/heads/main\n");
        tree.write(".git/info/exclude", "keep.txt\n");
        let (entries, _) = tree.list(Options {
            exclude: vec!["node_modules".into()],
            ..options()
        });
        assert_eq!(
            entries,
            [
                "f .gitignore",
                "d sub",
                "f sub/.gitignore",
                "f sub/keep.txt"
            ]
        );
        let (entries, _) = tree.list(Options {
            gitignore: false,
            ..options()
        });
        assert!(entries.contains(&"f out/x.js".to_string()));
        assert!(!entries.iter().any(|entry| entry.contains(".git/")));
        // A subdirectory of a work tree applies the rules of its parents.
        let sub = list(&tree.0.join("sub").to_string_lossy(), &options(), &|| false).unwrap();
        assert_eq!(sub.payload, b"f.gitignore\0fkeep.txt\0");
    }

    #[cfg(unix)]
    #[test]
    fn lists_symbolic_links_without_following_them() {
        let tree = Tree::new(&["dir/inner.txt"]);
        std::os::unix::fs::symlink(tree.0.join("dir"), tree.0.join("link")).unwrap();
        std::os::unix::fs::symlink("missing", tree.0.join("dangling")).unwrap();
        std::os::unix::fs::symlink(&tree.0, tree.0.join("dir/loop")).unwrap();
        let (entries, _) = tree.list(options());
        assert_eq!(
            entries,
            [
                "l dangling",
                "d dir",
                "f dir/inner.txt",
                "l dir/loop",
                "l link"
            ]
        );
    }

    #[test]
    fn stops_at_bounds_with_truncated() {
        let tree = Tree::new(&["a", "b", "c"]);
        let (entries, truncated) = tree.list(Options {
            max_entries: 2,
            ..options()
        });
        assert_eq!((entries.len(), truncated), (2, true));
        let (entries, truncated) = tree.list(Options {
            max_entries: 3,
            ..options()
        });
        assert_eq!((entries.len(), truncated), (3, false));
        let (entries, truncated) = tree.list(Options {
            max_bytes: 6,
            ..options()
        });
        assert_eq!(
            (entries, truncated),
            (vec!["f a".to_string(), "f b".to_string()], true)
        );
        let (entries, truncated) = tree.list(Options {
            timeout: Duration::ZERO,
            ..options()
        });
        assert!(truncated && entries.is_empty());
    }

    #[test]
    fn fails_on_missing_roots_files_and_aborts() {
        let tree = Tree::new(&["file"]);
        let missing = list(
            &tree.0.join("missing").to_string_lossy(),
            &options(),
            &|| false,
        );
        assert_eq!(missing.err().unwrap().code, "ENOENT");
        let file = list(&tree.0.join("file").to_string_lossy(), &options(), &|| {
            false
        });
        assert_eq!(file.err().unwrap().code, "ENOTDIR");
        let aborted = list(&tree.0.to_string_lossy(), &options(), &|| true);
        assert_eq!(aborted.err().unwrap().code, "aborted");
    }
}

// Ignore-aware traversal shared by filename and content search.
use crate::Control;
use globset::{GlobBuilder, GlobMatcher, GlobSetBuilder};
use ignore::WalkBuilder;
use napi_derive::napi;
use regex_syntax::{
    ParserBuilder,
    hir::{Class, Hir, HirKind},
};
use std::{
    cmp::Reverse,
    collections::{BTreeSet, HashSet},
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[napi(object)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

#[napi(object)]
pub struct SearchTarget {
    pub path: String,
    pub glob: Option<String>,
    pub ranges: Vec<LineRange>,
}

#[napi(object)]
pub struct GlobOptions {
    pub targets: Vec<SearchTarget>,
    pub exclusions: Vec<String>,
    pub pattern: String,
    pub hidden: bool,
    pub gitignore: bool,
    pub limit: u32,
}

#[napi(object)]
pub struct GlobResult {
    pub paths: Vec<String>,
    pub limit_reached: bool,
}

pub enum Entries {
    Files,
    Paths { hidden: bool },
}

pub fn glob(options: &GlobOptions, control: &Control) -> io::Result<GlobResult> {
    let entries = Entries::Paths {
        hidden: options.hidden,
    };
    // Keep only the newest page plus one proof of truncation, not every match in the tree.
    let mut selected: BTreeSet<(Reverse<SystemTime>, PathBuf, bool)> = BTreeSet::new();
    visit(
        &options.targets,
        &options.exclusions,
        entries,
        options.gitignore,
        Some(&options.pattern),
        control,
        |path, _target, is_dir, _explicit| {
            let modified = fs::symlink_metadata(path)?
                .modified()
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if selected.len() > options.limit as usize
                && selected.last().is_some_and(|(time, existing, kind)| {
                    (Reverse(modified), path, is_dir) >= (*time, existing.as_path(), *kind)
                })
            {
                return Ok(true);
            }
            selected.insert((Reverse(modified), path.to_path_buf(), is_dir));
            if selected.len() > options.limit as usize + 1 {
                selected.pop_last();
            }
            Ok(true)
        },
    )?;
    let limit_reached = selected.len() > options.limit as usize;
    let paths = selected
        .into_iter()
        .take(options.limit as usize)
        .map(|(_, path, is_dir)| {
            let mut text = display_path(&path);
            if is_dir {
                text.push('/');
            }
            text
        })
        .collect();
    Ok(GlobResult {
        paths,
        limit_reached,
    })
}

/// Render platform separators without changing literal backslashes on POSIX.
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

pub fn compile_glob(pattern: &str) -> io::Result<GlobMatcher> {
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .backslash_escape(false)
        .build()
        .map(|glob| glob.compile_matcher())
        .map_err(io::Error::other)
}

pub fn visit(
    targets: &[SearchTarget],
    exclusions: &[String],
    entries: Entries,
    gitignore: bool,
    filter_pattern: Option<&str>,
    control: &Control,
    mut visitor: impl FnMut(&Path, &SearchTarget, bool, bool) -> io::Result<bool>,
) -> io::Result<()> {
    let negated_globs = matches!(&entries, Entries::Files);
    let (hidden, symlinks) = match entries {
        Entries::Files => (true, false),
        Entries::Paths { hidden } => (hidden, true),
    };
    let path_filter = filter_pattern
        .map(|pattern| {
            let negated = negated_globs && pattern.starts_with('!');
            let pattern = if negated { &pattern[1..] } else { pattern };
            compile_glob(pattern).map(|glob| (glob, negated))
        })
        .transpose()?;
    let filter_depth = path_filter
        .as_ref()
        .filter(|(_, negated)| !negated)
        .and_then(|(glob, _)| glob_max_depth(glob));
    let mut excluded = GlobSetBuilder::new();
    for pattern in exclusions {
        excluded.add(
            GlobBuilder::new(pattern)
                .literal_separator(true)
                .backslash_escape(false)
                .build()
                .map_err(io::Error::other)?,
        );
    }
    let excluded = std::sync::Arc::new(excluded.build().map_err(io::Error::other)?);
    let mut visited = (targets.len() > 1).then(HashSet::new);
    for target in targets {
        control.check()?;
        let root = Path::new(&target.path);
        let metadata = match fs::metadata(root) {
            Ok(metadata) => metadata,
            Err(error)
                if symlinks
                    && matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                    ) =>
            {
                fs::symlink_metadata(root)?
            }
            Err(error) => return Err(error),
        };
        if metadata.is_file() || (symlinks && metadata.file_type().is_symlink()) {
            if visited
                .as_mut()
                .is_none_or(|seen| seen.insert(root.to_path_buf()))
                && !visitor(root, target, false, true)?
            {
                break;
            }
            continue;
        }
        if !metadata.is_dir() {
            return Err(io::Error::other(format!(
                "Not a directory or regular file: {}",
                root.display()
            )));
        }
        if root.ancestors().any(|ancestor| excluded.is_match(ancestor)) {
            continue;
        }
        let selector = target.glob.as_deref().map(compile_glob).transpose()?;
        let include_node_modules = target.path.contains("node_modules")
            || target
                .glob
                .as_deref()
                .is_some_and(|glob| glob.contains("node_modules"))
            || filter_pattern.is_some_and(|pattern| pattern.contains("node_modules"));
        let mut builder = WalkBuilder::new(root);
        builder
            .hidden(!hidden)
            .follow_links(false)
            .ignore(gitignore)
            .git_ignore(gitignore)
            .git_global(gitignore)
            .git_exclude(gitignore)
            .require_git(inside_git_repository(root))
            .sort_by_file_path(Path::cmp);
        builder.max_depth(
            [selector.as_ref().and_then(glob_max_depth), filter_depth]
                .into_iter()
                .flatten()
                .min(),
        );
        let filter = excluded.clone();
        let negative = path_filter
            .as_ref()
            .filter(|(_, negated)| *negated)
            .map(|(glob, _)| (root.to_path_buf(), glob.clone()));
        builder.filter_entry(move |entry| {
            entry.depth() == 0
                || (entry.file_name() != ".git"
                    && (include_node_modules || entry.file_name() != "node_modules")
                    && !filter.is_match(entry.path())
                    && !negative.as_ref().is_some_and(|(root, glob)| {
                        glob.is_match(entry.path().strip_prefix(root).unwrap_or(entry.path()))
                    }))
        });
        for entry in builder.build() {
            control.check()?;
            let entry = entry.map_err(io::Error::other)?;
            if let Some(error) = entry.error() {
                return Err(io::Error::other(error.to_string()));
            }
            if entry.depth() == 0 {
                continue;
            }
            let Some(kind) = entry.file_type() else {
                continue;
            };
            let is_dir = kind.is_dir();
            if !is_dir && !kind.is_file() && !(symlinks && kind.is_symlink()) {
                continue;
            }
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap_or(path);
            if selector
                .as_ref()
                .is_some_and(|glob| !glob.is_match(relative))
                || path_filter
                    .as_ref()
                    .is_some_and(|(glob, negated)| !negated && !glob.is_match(relative))
            {
                continue;
            }
            if visited
                .as_mut()
                .is_some_and(|seen| !seen.insert(path.to_path_buf()))
            {
                continue;
            }
            if !visitor(path, target, is_dir, false)? {
                return Ok(());
            }
        }
    }
    control.check()
}

fn inside_git_repository(root: &Path) -> bool {
    root.ancestors()
        .any(|directory| directory.join(".git").exists())
}

fn glob_max_depth(glob: &GlobMatcher) -> Option<usize> {
    // Use globset's own language: brace branches take a maximum and classes can match separators.
    let hir = ParserBuilder::new()
        .utf8(false)
        .dot_matches_new_line(true)
        .build()
        .parse(glob.glob().regex())
        .expect("compiled globset regex is valid");
    max_separators(&hir)?.checked_add(1)
}

fn max_separators(hir: &Hir) -> Option<usize> {
    match hir.kind() {
        HirKind::Empty | HirKind::Look(_) => Some(0),
        HirKind::Literal(literal) => Some(literal.0.iter().filter(|&&byte| byte == b'/').count()),
        HirKind::Class(class) => Some(usize::from(match class {
            Class::Bytes(class) => class
                .iter()
                .any(|range| range.start() <= b'/' && b'/' <= range.end()),
            Class::Unicode(class) => class
                .iter()
                .any(|range| range.start() <= '/' && '/' <= range.end()),
        })),
        HirKind::Capture(capture) => max_separators(&capture.sub),
        HirKind::Repetition(repetition) => {
            let count = max_separators(&repetition.sub)?;
            if count == 0 {
                Some(0)
            } else {
                count.checked_mul(repetition.max? as usize)
            }
        }
        HirKind::Concat(parts) => parts.iter().try_fold(0usize, |count, part| {
            count.checked_add(max_separators(part)?)
        }),
        HirKind::Alternation(parts) => parts
            .iter()
            .try_fold(0usize, |count, part| Some(count.max(max_separators(part)?))),
    }
}

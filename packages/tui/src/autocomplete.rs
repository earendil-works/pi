use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FuzzyMatch {
    pub score: i64,
    pub indices: Vec<usize>,
}
#[must_use]
pub fn fuzzy_match(query: &str, candidate: &str) -> Option<FuzzyMatch> {
    if query.is_empty() {
        return Some(FuzzyMatch {
            score: 0,
            indices: Vec::new(),
        });
    }
    let query = query.to_lowercase();
    let candidate_lower = candidate.to_lowercase();
    let mut indices = Vec::new();
    let mut cursor = 0;
    let mut score = 0;
    for needle in query.chars() {
        let position = candidate_lower[cursor..].find(needle)? + cursor;
        indices.push(position);
        score += if position == cursor { 10 } else { 1 };
        if position == 0
            || candidate
                .as_bytes()
                .get(position.wrapping_sub(1))
                .is_some_and(|byte| matches!(byte, b'/' | b'-' | b'_' | b' '))
        {
            score += 8
        }
        cursor = position + needle.len_utf8();
    }
    score -= i64::try_from(candidate.len().saturating_sub(query.len())).unwrap_or(i64::MAX) / 10;
    Some(FuzzyMatch { score, indices })
}
#[must_use]
pub fn fuzzy_filter<'a>(query: &str, candidates: impl IntoIterator<Item = &'a str>) -> Vec<(&'a str, FuzzyMatch)> {
    let mut result = candidates
        .into_iter()
        .filter_map(|candidate| fuzzy_match(query, candidate).map(|matched| (candidate, matched)))
        .collect::<Vec<_>>();
    result.sort_by(|(a, ma), (b, mb)| mb.score.cmp(&ma.score).then_with(|| a.cmp(b)));
    result
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutocompleteItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutocompleteSuggestions {
    pub items: Vec<AutocompleteItem>,
    pub replace_start: usize,
    pub replace_end: usize,
}
pub trait AutocompleteProvider: Send + Sync {
    fn suggestions(&self, text: &str, cursor: usize) -> Option<AutocompleteSuggestions>;
}

pub struct CombinedAutocompleteProvider {
    commands: Vec<SlashCommand>,
    cwd: PathBuf,
    max_files: usize,
}
impl CombinedAutocompleteProvider {
    #[must_use]
    pub fn new(commands: Vec<SlashCommand>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            commands,
            cwd: cwd.into(),
            max_files: 200,
        }
    }
    fn slash(&self, text: &str, cursor: usize) -> Option<AutocompleteSuggestions> {
        if !text.starts_with('/') || text[..cursor].contains(char::is_whitespace) {
            return None;
        }
        let query = &text[1..cursor];
        let mut matches = self
            .commands
            .iter()
            .filter_map(|command| fuzzy_match(query, &command.name).map(|matched| (command, matched)))
            .collect::<Vec<_>>();
        matches.sort_by(|(_, a), (_, b)| b.score.cmp(&a.score));
        Some(AutocompleteSuggestions {
            items: matches
                .into_iter()
                .map(|(command, _)| AutocompleteItem {
                    value: format!("/{}", command.name),
                    label: command.name.clone(),
                    description: command.description.clone(),
                })
                .collect(),
            replace_start: 0,
            replace_end: cursor,
        })
    }
    fn files(&self, text: &str, cursor: usize) -> Option<AutocompleteSuggestions> {
        let start = text[..cursor].rfind(char::is_whitespace).map_or(0, |index| index + 1);
        let token = &text[start..cursor];
        if !(token.starts_with('@') || token.starts_with("./") || token.starts_with("../") || token.starts_with('~')) {
            return None;
        }
        let raw = token.trim_start_matches('@');
        let root = if raw.starts_with('~') {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| self.cwd.clone())
        } else {
            self.cwd.clone()
        };
        let query = raw.trim_start_matches(['~', '/', '.']);
        let mut paths = WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .max_depth(Some(10))
            .build()
            .filter_map(Result::ok)
            .filter(|entry| entry.path() != root)
            .filter_map(|entry| entry.path().strip_prefix(&root).ok().map(Path::to_path_buf))
            .filter_map(|path| {
                let display = path.to_string_lossy().to_string();
                fuzzy_match(query, &display).map(|matched| (display, entry_suffix(&root.join(path)), matched))
            })
            .collect::<Vec<_>>();
        paths.sort_by(|a, b| b.2.score.cmp(&a.2.score));
        paths.truncate(self.max_files);
        Some(AutocompleteSuggestions {
            items: paths
                .into_iter()
                .map(|(path, suffix, _)| AutocompleteItem {
                    value: format!("{}{}{}", if token.starts_with('@') { "@" } else { "" }, path, suffix),
                    label: format!("{path}{suffix}"),
                    description: None,
                })
                .collect(),
            replace_start: start,
            replace_end: cursor,
        })
    }
}
impl AutocompleteProvider for CombinedAutocompleteProvider {
    fn suggestions(&self, text: &str, cursor: usize) -> Option<AutocompleteSuggestions> {
        self.slash(text, cursor).or_else(|| self.files(text, cursor))
    }
}
fn entry_suffix(path: &Path) -> &'static str {
    if path.is_dir() { "/" } else { "" }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fuzzy_prefers_boundaries() {
        let results = fuzzy_filter("fb", ["foo-bar", "fizzbuzz"]);
        assert_eq!(results[0].0, "foo-bar");
    }
}

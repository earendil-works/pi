import re
import asyncio
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol, Union
from abc import abstractmethod
from os.path import expanduser, basename, dirname, join, isdir

from pi_mono.tui.fuzzy import fuzzy_filter
from pi_mono.utils.abort_signals import AbortSignal

PATH_DELIMITERS = {" ", "\t", '"', "'", "="}


def to_display_path(value: str) -> str:
    """Normalize path to use forward slashes for display."""
    return value.replace("\\", "/")


def escape_regex(value: str) -> str:
    """Escape special regex characters."""
    return re.sub(r"[.*+?^${}()|[\]\\]", r"\\$&", value)


def build_fd_path_query(query: str) -> str:
    """Build fd query pattern from user input."""
    normalized = to_display_path(query)
    if "/" not in normalized:
        return normalized

    has_trailing_separator = normalized.endswith("/")
    trimmed = re.sub(r"^/+|/+$", "", normalized)
    if not trimmed:
        return normalized

    separator_pattern = r"[\\\\/]"
    segments = [escape_regex(segment) for segment in trimmed.split("/") if segment]
    if not segments:
        return normalized

    pattern = separator_pattern.join(segments)
    if has_trailing_separator:
        pattern += separator_pattern
    return pattern


def find_last_delimiter(text: str) -> int:
    """Find the last delimiter position in text."""
    for i in range(len(text) - 1, -1, -1):
        if text[i] in PATH_DELIMITERS:
            return i
    return -1


def find_unclosed_quote_start(text: str) -> Optional[int]:
    """Find the start of an unclosed quote if present."""
    in_quotes = False
    quote_start = -1
    for i, ch in enumerate(text):
        if ch == '"':
            in_quotes = not in_quotes
            if in_quotes:
                quote_start = i
    return quote_start if in_quotes else None


def is_token_start(text: str, index: int) -> bool:
    """Check if index is at the start of a token."""
    return index == 0 or text[index - 1] in PATH_DELIMITERS


def extract_quoted_prefix(text: str) -> Optional[str]:
    """Extract a quoted prefix if one exists at the end of text."""
    quote_start = find_unclosed_quote_start(text)
    if quote_start is None:
        return None
    if quote_start > 0 and text[quote_start - 1] == "@":
        if not is_token_start(text, quote_start - 1):
            return None
        return text[quote_start - 1 :]
    if not is_token_start(text, quote_start):
        return None
    return text[quote_start:]


def parse_path_prefix(prefix: str) -> Dict[str, Any]:
    """Parse a path prefix into its components."""
    if prefix.startswith('@"'):
        return {"rawPrefix": prefix[2:], "isAtPrefix": True, "isQuotedPrefix": True}
    if prefix.startswith('"'):
        return {"rawPrefix": prefix[1:], "isAtPrefix": False, "isQuotedPrefix": True}
    if prefix.startswith("@"):
        return {"rawPrefix": prefix[1:], "isAtPrefix": True, "isQuotedPrefix": False}
    return {"rawPrefix": prefix, "isAtPrefix": False, "isQuotedPrefix": False}


def build_completion_value(
    path: str,
    options: Dict[str, Any],
) -> str:
    """Build the completion value with appropriate quoting."""
    needs_quotes = options.get("isQuotedPrefix", False) or " " in path
    prefix = "@" if options.get("isAtPrefix", False) else ""

    if not needs_quotes:
        return f"{prefix}{path}"

    open_quote = f'{prefix}"'
    close_quote = '"'
    return f"{open_quote}{path}{close_quote}"


async def walk_directory_with_fd(
    base_dir: str,
    fd_path: str,
    query: str,
    max_results: int,
    signal: AbortSignal,
) -> List[Dict[str, Any]]:
    """Walk directory tree using fd (fast, respects .gitignore)."""
    args = [
        "--base-directory",
        base_dir,
        "--max-results",
        str(max_results),
        "--type",
        "f",
        "--type",
        "d",
        "--follow",
        "--hidden",
        "--exclude",
        ".git",
        "--exclude",
        ".git/*",
        "--exclude",
        ".git/**",
    ]

    if "/" in to_display_path(query):
        args.append("--full-path")

    if query:
        args.append(build_fd_path_query(query))

    def run_fd() -> List[Dict[str, Any]]:
        if signal.aborted:
            return []

        process = subprocess.Popen(
            [fd_path] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        try:
            stdout, stderr = process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            return []

        if signal.aborted or process.returncode != 0 or not stdout:
            return []

        lines = stdout.strip().split("\n")
        results = []

        for line in lines:
            line = line.strip()
            if not line:
                continue

            display_line = to_display_path(line)
            has_trailing_separator = display_line.endswith("/")
            normalized_path = display_line[:-1] if has_trailing_separator else display_line

            if normalized_path == ".git" or normalized_path.startswith(".git/"):
                continue

            results.append({"path": display_line, "isDirectory": has_trailing_separator})

        return results

    # Run in thread pool to not block event loop
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, run_fd)


class AutocompleteItem:
    """Represents a single autocomplete suggestion."""

    def __init__(self, value: str, label: str, description: Optional[str] = None) -> None:
        self.value = value
        self.label = label
        self.description = description


class SlashCommand:
    """Represents a slash command configuration."""

    def __init__(
        self,
        name: str,
        description: Optional[str] = None,
        argument_hint: Optional[str] = None,
        get_argument_completions: Optional[Callable[[str], Any]] = None,
    ) -> None:
        self.name = name
        self.description = description
        self.argumentHint = argument_hint
        self.getArgumentCompletions = get_argument_completions


class AutocompleteSuggestions:
    """Represents a list of autocomplete suggestions and the active prefix."""

    def __init__(self, items: List[AutocompleteItem], prefix: str) -> None:
        self.items = items
        self.prefix = prefix


class AutocompleteProvider(Protocol):
    """Protocol for autocomplete providers."""

    @abstractmethod
    async def get_suggestions(
        self,
        lines: List[str],
        cursor_line: int,
        cursor_col: int,
        options: Dict[str, Any],
    ) -> Optional[AutocompleteSuggestions]:
        """Get autocomplete suggestions for current text/cursor position.
        Returns None if no suggestions available."""
        ...

    @abstractmethod
    def apply_completion(
        self,
        lines: List[str],
        cursor_line: int,
        cursor_col: int,
        item: Any,
        prefix: str,
    ) -> Dict[str, Any]:
        """Apply the selected item.
        Returns the new text and cursor position."""
        ...

    def should_trigger_file_completion(
        self, lines: List[str], cursor_line: int, cursor_col: int
    ) -> bool:
        """Check if file completion should trigger for explicit Tab completion."""
        return False


class CombinedAutocompleteProvider:
    """Combined provider that handles both slash commands and file paths."""

    def __init__(
        self,
        commands: Optional[List[Union[SlashCommand, AutocompleteItem]]] = None,
        base_path: str = ".",
        fd_path: Optional[str] = None,
    ) -> None:
        self.commands = commands or []
        self.base_path = base_path
        self.fd_path = fd_path

    def _to_display_path(self, value: str) -> str:
        return to_display_path(value)

    def _expand_home_path(self, path: str) -> str:
        """Expand home directory (~/) to actual home path."""
        if path.startswith("~/"):
            expanded = join(expanduser("~"), path[2:])
            # Preserve trailing slash if original path had one
            if path.endswith("/") and not expanded.endswith("/"):
                return f"{expanded}/"
            return expanded
        if path == "~":
            return expanduser("~")
        return path

    def _extract_at_prefix(self, text: str) -> Optional[str]:
        """Extract @ prefix for fuzzy file suggestions."""
        quoted_prefix = extract_quoted_prefix(text)
        if quoted_prefix and quoted_prefix.startswith('@"'):
            return quoted_prefix

        last_delimiter_index = find_last_delimiter(text)
        token_start = 0 if last_delimiter_index == -1 else last_delimiter_index + 1

        if token_start < len(text) and text[token_start] == "@":
            return text[token_start:]

        return None

    def _extract_path_prefix(self, text: str, force_extract: bool = False) -> Optional[str]:
        """Extract a path-like prefix from the text before cursor."""
        quoted_prefix = extract_quoted_prefix(text)
        if quoted_prefix:
            return quoted_prefix

        last_delimiter_index = find_last_delimiter(text)
        path_prefix = text if last_delimiter_index == -1 else text[last_delimiter_index + 1 :]

        # For forced extraction (Tab key), always return something
        if force_extract:
            return path_prefix

        # For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
        # Only return empty string if the text looks like it's starting a path context
        if "/" in path_prefix or path_prefix.startswith(".") or path_prefix.startswith("~/"):
            return path_prefix

        # Return empty string only after a space (not for completely empty text)
        # Empty text should not trigger file suggestions - that's for forced Tab completion
        if path_prefix == "" and text.endswith(" "):
            return path_prefix

        return None

    def _resolve_scoped_fuzzy_query(self, raw_query: str) -> Optional[Dict[str, str]]:
        """Resolve a scoped fuzzy query like 'src/components/bu'."""
        normalized_query = self._to_display_path(raw_query)
        slash_index = normalized_query.rfind("/")
        if slash_index == -1:
            return None

        display_base = normalized_query[: slash_index + 1]
        query = normalized_query[slash_index + 1 :]

        if display_base.startswith("~/"):
            base_dir = self._expand_home_path(display_base)
        elif display_base.startswith("/"):
            base_dir = display_base
        else:
            base_dir = join(self.base_path, display_base)

        try:
            if not isdir(base_dir):
                return None
        except OSError:
            return None

        return {"baseDir": base_dir, "query": query, "displayBase": display_base}

    def _scoped_path_for_display(self, display_base: str, relative_path: str) -> str:
        """Convert relative path to display path."""
        normalized_relative = self._to_display_path(relative_path)
        if display_base == "/":
            return f"/{normalized_relative}"
        return f"{self._to_display_path(display_base)}{normalized_relative}"

    def _get_file_suggestions(self, prefix: str) -> List[AutocompleteItem]:
        """Get file/directory suggestions for a given path prefix (synchronous)."""
        try:
            raw_prefix = prefix
            parse_result = parse_path_prefix(prefix)
            is_at_prefix = parse_result["isAtPrefix"]
            is_quoted_prefix = parse_result["isQuotedPrefix"]
            expanded_prefix = self._expand_home_path(parse_result["rawPrefix"])

            is_root_prefix = (
                raw_prefix == ""
                or raw_prefix == "./"
                or raw_prefix == "../"
                or raw_prefix == "~"
                or raw_prefix == "~/"
                or raw_prefix == "/"
                or (is_at_prefix and raw_prefix == "")
            )

            if is_root_prefix:
                # Complete from specified position
                if raw_prefix.startswith("~") or expanded_prefix.startswith("/"):
                    search_dir = expanded_prefix
                else:
                    search_dir = join(self.base_path, expanded_prefix)
                search_prefix = ""
            elif expanded_prefix.endswith("/"):
                # If prefix ends with /, show contents of that directory
                if raw_prefix.startswith("~") or expanded_prefix.startswith("/"):
                    search_dir = expanded_prefix
                else:
                    search_dir = join(self.base_path, expanded_prefix)
                search_prefix = ""
            else:
                # Split into directory and file prefix
                search_dir = dirname(expanded_prefix)
                search_prefix = basename(expanded_prefix)
                if raw_prefix.startswith("~") or expanded_prefix.startswith("/"):
                    search_dir = search_dir
                else:
                    search_dir = join(self.base_path, search_dir)

            suggestions = []

            try:
                entries = list(Path(search_dir).iterdir())
            except (OSError, PermissionError):
                return []

            for entry in entries:
                if not entry.name.lower().startswith(search_prefix.lower()):
                    continue

                try:
                    is_directory = entry.is_dir()
                except OSError:
                    is_directory = False

                if not is_directory and entry.is_symlink():
                    try:
                        is_directory = entry.stat().st_mode & 0o170000 == 0o040000
                    except OSError:
                        pass

                name = entry.name
                display_prefix = raw_prefix

                if display_prefix.endswith("/"):
                    # If prefix ends with /, append entry to the prefix
                    relative_path = display_prefix + name
                elif "/" in display_prefix or "\\" in display_prefix:
                    # Preserve ~/ format for home directory paths
                    if display_prefix.startswith("~/"):
                        home_relative_dir = display_prefix[2:]  # Remove ~/
                        d = dirname(home_relative_dir)
                        relative_path = f"~/{name if d == '.' else join(d, name)}"
                    elif display_prefix.startswith("/"):
                        # Absolute path - construct properly
                        d = dirname(display_prefix)
                        if d == "/":
                            relative_path = f"/{name}"
                        else:
                            relative_path = f"{d}/{name}"
                    else:
                        relative_path = join(dirname(display_prefix), name)
                        # path.join normalizes away ./ prefix, preserve it
                        if display_prefix.startswith("./") and not relative_path.startswith("./"):
                            relative_path = f"./{relative_path}"
                else:
                    # For standalone entries, preserve ~/ if original prefix was ~/
                    if display_prefix.startswith("~"):
                        relative_path = f"~/{name}"
                    else:
                        relative_path = name

                relative_path = self._to_display_path(relative_path)
                path_value = f"{relative_path}/" if is_directory else relative_path
                value = build_completion_value(
                    path_value,
                    {
                        "isDirectory": is_directory,
                        "isAtPrefix": is_at_prefix,
                        "isQuotedPrefix": is_quoted_prefix,
                    },
                )

                suggestions.append(
                    AutocompleteItem(
                        value=value,
                        label=name + ("/" if is_directory else ""),
                    )
                )

            # Sort directories first, then alphabetically
            suggestions.sort(key=lambda s: (not s.value.endswith("/"), s.label.lower()))

            return suggestions

        except Exception:
            # Directory doesn't exist or not accessible
            return []

    def _score_entry(self, file_path: str, query: str, is_directory: bool) -> int:
        """Score an entry against the query (higher = better match)."""
        file_name = basename(file_path)
        lower_file_name = file_name.lower()
        lower_query = query.lower()

        score = 0

        # Exact filename match (highest)
        if lower_file_name == lower_query:
            score = 100
        # Filename starts with query
        elif lower_file_name.startswith(lower_query):
            score = 80
        # Substring match in filename
        elif lower_query in lower_file_name:
            score = 50
        # Substring match in full path
        elif lower_query in file_path.lower():
            score = 30

        # Directories get a bonus to appear first
        if is_directory and score > 0:
            score += 10

        return score

    async def _get_fuzzy_file_suggestions(
        self,
        query: str,
        options: Dict[str, Any],
    ) -> List[AutocompleteItem]:
        """Fuzzy file search using fd (fast, respects .gitignore)."""
        if not self.fd_path or options.get("signal", AbortSignal()).aborted:
            return []

        try:
            scoped_query = self._resolve_scoped_fuzzy_query(query)
            fd_base_dir = scoped_query["baseDir"] if scoped_query else self.base_path
            fd_query = scoped_query["query"] if scoped_query else query

            entries = await walk_directory_with_fd(
                fd_base_dir, self.fd_path, fd_query, 100, options["signal"]
            )

            if options.get("signal", AbortSignal()).aborted:
                return []

            scored_entries = []
            for entry in entries:
                score = (
                    self._score_entry(entry["path"], fd_query, entry["isDirectory"])
                    if fd_query
                    else 1
                )
                if score > 0:
                    scored_entries.append({**entry, "score": score})

            scored_entries.sort(key=lambda x: -x["score"])
            top_entries = scored_entries[:20]

            suggestions = []
            for entry in top_entries:
                path_without_slash = entry["path"][:-1] if entry["isDirectory"] else entry["path"]
                display_path = (
                    self._scoped_path_for_display(scoped_query["displayBase"], path_without_slash)
                    if scoped_query
                    else path_without_slash
                )
                entry_name = basename(path_without_slash)
                completion_path = f"{display_path}/" if entry["isDirectory"] else display_path
                value = build_completion_value(
                    completion_path,
                    {
                        "isDirectory": entry["isDirectory"],
                        "isAtPrefix": True,
                        "isQuotedPrefix": options.get("isQuotedPrefix", False),
                    },
                )

                suggestions.append(
                    AutocompleteItem(
                        value=value,
                        label=entry_name + ("/" if entry["isDirectory"] else ""),
                        description=display_path,
                    )
                )

            return suggestions

        except Exception:
            return []

    async def get_suggestions(
        self,
        lines: List[str],
        cursor_line: int,
        cursor_col: int,
        options: Dict[str, Any],
    ) -> Optional[AutocompleteSuggestions]:
        """Get autocomplete suggestions for current text/cursor position."""
        current_line = lines[cursor_line] if cursor_line < len(lines) else ""
        text_before_cursor = current_line[:cursor_col]

        # Check for @ prefix (fuzzy file suggestions)
        at_prefix = self._extract_at_prefix(text_before_cursor)
        if at_prefix:
            parse_result = parse_path_prefix(at_prefix)
            suggestions = await self._get_fuzzy_file_suggestions(
                parse_result["rawPrefix"],
                {
                    "isQuotedPrefix": parse_result["isQuotedPrefix"],
                    "signal": options.get("signal", AbortSignal()),
                },
            )
            if not suggestions:
                return None
            return AutocompleteSuggestions(suggestions, at_prefix)

        # Check for slash commands
        force = options.get("force", False)
        if not force and text_before_cursor.startswith("/"):
            space_index = text_before_cursor.find(" ")

            if space_index == -1:
                # No space - completing command name
                prefix = text_before_cursor[1:]
                command_items = []
                for cmd in self.commands:
                    name = cmd.name if hasattr(cmd, "name") else cmd.value
                    hint = (
                        getattr(cmd, "argumentHint", None) if hasattr(cmd, "argumentHint") else None
                    )
                    desc = cmd.description if hasattr(cmd, "description") else ""
                    full_desc = hint if hint else desc
                    if hint and desc:
                        full_desc = f"{hint} — {desc}"
                    command_items.append(
                        AutocompleteItem(value=name, label=name, description=full_desc or None)
                    )

                filtered = fuzzy_filter(command_items, prefix, lambda item: item.value)

                if not filtered:
                    return None

                return AutocompleteSuggestions(filtered, text_before_cursor)

            # Has space - completing command argument
            command_name = text_before_cursor[1:space_index]
            argument_text = text_before_cursor[space_index + 1 :]

            command = None
            for cmd in self.commands:
                name = cmd.name if hasattr(cmd, "name") else cmd.value
                if name == command_name:
                    command = cmd
                    break

            if (
                not command
                or not hasattr(command, "getArgumentCompletions")
                or not command.getArgumentCompletions
            ):
                return None

            argument_suggestions = await command.getArgumentCompletions(argument_text)
            if not argument_suggestions or len(argument_suggestions) == 0:
                return None

            # Convert to AutocompleteItem if needed
            items = []
            for item in argument_suggestions:
                if isinstance(item, AutocompleteItem):
                    items.append(item)
                elif isinstance(item, dict):
                    items.append(
                        AutocompleteItem(
                            value=item.get("value", ""),
                            label=item.get("label", ""),
                            description=item.get("description"),
                        )
                    )
                else:
                    items.append(AutocompleteItem(value=str(item), label=str(item)))

            if not items:
                return None

            return AutocompleteSuggestions(items, argument_text)

        # Check for file path completion
        path_match = self._extract_path_prefix(text_before_cursor, force)
        if path_match is None:
            return None

        suggestions = self._get_file_suggestions(path_match)
        if not suggestions:
            return None

        return AutocompleteSuggestions(suggestions, path_match)

    def apply_completion(
        self,
        lines: List[str],
        cursor_line: int,
        cursor_col: int,
        item: AutocompleteItem,
        prefix: str,
    ) -> Dict[str, Any]:
        """Apply the selected item. Returns the new text and cursor position."""
        current_line = lines[cursor_line] if cursor_line < len(lines) else ""
        before_prefix = current_line[: cursor_col - len(prefix)]
        after_cursor = current_line[cursor_col:]

        is_quoted_prefix = prefix.startswith('"') or prefix.startswith('@"')
        has_leading_quote_after_cursor = after_cursor.startswith('"')
        has_trailing_quote_in_item = item.value.endswith('"')

        adjusted_after_cursor = after_cursor
        if is_quoted_prefix and has_trailing_quote_in_item and has_leading_quote_after_cursor:
            adjusted_after_cursor = after_cursor[1:]

        # Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
        # Slash commands are at the start of the line and don't contain path separators after the first /
        is_slash_command = (
            prefix.startswith("/") and before_prefix.strip() == "" and "/" not in prefix[1:]
        )

        if is_slash_command:
            # This is a command name completion
            new_line = f"{before_prefix}/{item.value} {adjusted_after_cursor}"
            new_lines = list(lines)
            new_lines[cursor_line] = new_line

            return {
                "lines": new_lines,
                "cursorLine": cursor_line,
                "cursorCol": len(before_prefix) + len(item.value) + 2,  # +2 for "/" and space
            }

        # Check if we're completing a file attachment (prefix starts with "@")
        if prefix.startswith("@"):
            # This is a file attachment completion
            # Don't add space after directories so user can continue autocompleting
            is_directory = item.label.endswith("/")
            suffix = "" if is_directory else " "
            new_line = f"{before_prefix + item.value}{suffix}{adjusted_after_cursor}"
            new_lines = list(lines)
            new_lines[cursor_line] = new_line

            has_trailing_quote = item.value.endswith('"')
            cursor_offset = (
                len(item.value) - 1 if is_directory and has_trailing_quote else len(item.value)
            )

            return {
                "lines": new_lines,
                "cursorLine": cursor_line,
                "cursorCol": len(before_prefix) + cursor_offset + len(suffix),
            }

        # Check if we're in a slash command context (beforePrefix contains "/command ")
        text_before_cursor_full = current_line[:cursor_col]
        if text_before_cursor_full.find("/") != -1 and " " in text_before_cursor_full:
            # This is likely a command argument completion
            new_line = f"{before_prefix}{item.value}{adjusted_after_cursor}"
            new_lines = list(lines)
            new_lines[cursor_line] = new_line

            is_directory = item.label.endswith("/")
            has_trailing_quote = item.value.endswith('"')
            cursor_offset = (
                len(item.value) - 1 if is_directory and has_trailing_quote else len(item.value)
            )

            return {
                "lines": new_lines,
                "cursorLine": cursor_line,
                "cursorCol": len(before_prefix) + cursor_offset,
            }

        # For file paths, complete the path
        new_line = f"{before_prefix}{item.value}{adjusted_after_cursor}"
        new_lines = list(lines)
        new_lines[cursor_line] = new_line

        is_directory = item.label.endswith("/")
        has_trailing_quote = item.value.endswith('"')
        cursor_offset = (
            len(item.value) - 1 if is_directory and has_trailing_quote else len(item.value)
        )

        return {
            "lines": new_lines,
            "cursorLine": cursor_line,
            "cursorCol": len(before_prefix) + cursor_offset,
        }

    def should_trigger_file_completion(
        self, lines: List[str], cursor_line: int, cursor_col: int
    ) -> bool:
        """Check if we should trigger file completion (called on Tab key)."""
        current_line = lines[cursor_line] if cursor_line < len(lines) else ""
        text_before_cursor = current_line[:cursor_col]

        # Don't trigger if we're typing a slash command at the start of the line
        trimmed = text_before_cursor.strip()
        if trimmed.startswith("/") and " " not in trimmed:
            return False

        return True


__all__ = [
    "AutocompleteItem",
    "SlashCommand",
    "AutocompleteSuggestions",
    "AutocompleteProvider",
    "CombinedAutocompleteProvider",
    "PATH_DELIMITERS",
    "to_display_path",
    "escape_regex",
    "build_fd_path_query",
    "find_last_delimiter",
    "find_unclosed_quote_start",
    "is_token_start",
    "extract_quoted_prefix",
    "parse_path_prefix",
    "build_completion_value",
    "walk_directory_with_fd",
]

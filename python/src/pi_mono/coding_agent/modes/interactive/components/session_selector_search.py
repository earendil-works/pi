"""Session search parsing and filtering for the session selector."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from pi_mono.tui.fuzzy import fuzzy_match

SessionInfo = dict[str, Any]
SortMode = Literal["threaded", "recent", "relevance"]
NameFilter = Literal["all", "named"]


@dataclass
class SearchToken:
    kind: Literal["fuzzy", "phrase"]
    value: str


@dataclass
class ParsedSearchQuery:
    mode: Literal["tokens", "regex"]
    tokens: list[SearchToken]
    regex: re.Pattern[str] | None
    error: str | None = None


@dataclass
class MatchResult:
    matches: bool
    score: float


def _normalize_whitespace_lower(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def _get_session_search_text(session: SessionInfo) -> str:
    name = session.get("name") or ""
    return f"{session.get('id', '')} {name} {session.get('allMessagesText', '')} {session.get('cwd', '')}"


def has_session_name(session: SessionInfo) -> bool:
    name = session.get("name")
    return bool(isinstance(name, str) and name.strip())


def _matches_name_filter(session: SessionInfo, name_filter: NameFilter) -> bool:
    if name_filter == "all":
        return True
    return has_session_name(session)


def parse_search_query(query: str) -> ParsedSearchQuery:
    trimmed = query.strip()
    if not trimmed:
        return ParsedSearchQuery(mode="tokens", tokens=[], regex=None)

    if trimmed.startswith("re:"):
        pattern = trimmed[3:].strip()
        if not pattern:
            return ParsedSearchQuery(mode="regex", tokens=[], regex=None, error="Empty regex")
        try:
            return ParsedSearchQuery(
                mode="regex", tokens=[], regex=re.compile(pattern, re.IGNORECASE)
            )
        except re.error as error:
            return ParsedSearchQuery(mode="regex", tokens=[], regex=None, error=str(error))

    tokens: list[SearchToken] = []
    buf = ""
    in_quote = False
    had_unclosed_quote = False

    def flush(kind: Literal["fuzzy", "phrase"]) -> None:
        nonlocal buf
        value = buf.strip()
        buf = ""
        if value:
            tokens.append(SearchToken(kind=kind, value=value))

    for char in trimmed:
        if char == '"':
            if in_quote:
                flush("phrase")
                in_quote = False
            else:
                flush("fuzzy")
                in_quote = True
            continue

        if not in_quote and char.isspace():
            flush("fuzzy")
            continue

        buf += char

    if in_quote:
        had_unclosed_quote = True

    if had_unclosed_quote:
        fallback_tokens = [
            SearchToken(kind="fuzzy", value=part)
            for part in re.split(r"\s+", trimmed)
            if part.strip()
        ]
        return ParsedSearchQuery(mode="tokens", tokens=fallback_tokens, regex=None)

    flush("phrase" if in_quote else "fuzzy")
    return ParsedSearchQuery(mode="tokens", tokens=tokens, regex=None)


def match_session(session: SessionInfo, parsed: ParsedSearchQuery) -> MatchResult:
    text = _get_session_search_text(session)

    if parsed.mode == "regex":
        if parsed.regex is None:
            return MatchResult(matches=False, score=0.0)
        match = parsed.regex.search(text)
        if match is None:
            return MatchResult(matches=False, score=0.0)
        return MatchResult(matches=True, score=match.start() * 0.1)

    if not parsed.tokens:
        return MatchResult(matches=True, score=0.0)

    total_score = 0.0
    normalized_text: str | None = None

    for token in parsed.tokens:
        if token.kind == "phrase":
            if normalized_text is None:
                normalized_text = _normalize_whitespace_lower(text)
            phrase = _normalize_whitespace_lower(token.value)
            if not phrase:
                continue
            index = normalized_text.find(phrase)
            if index < 0:
                return MatchResult(matches=False, score=0.0)
            total_score += index * 0.1
            continue

        result = fuzzy_match(token.value, text)
        if not result.matches:
            return MatchResult(matches=False, score=0.0)
        total_score += result.score

    return MatchResult(matches=True, score=total_score)


def filter_and_sort_sessions(
    sessions: list[SessionInfo],
    query: str,
    sort_mode: SortMode,
    name_filter: NameFilter = "all",
) -> list[SessionInfo]:
    name_filtered = (
        sessions
        if name_filter == "all"
        else [session for session in sessions if _matches_name_filter(session, name_filter)]
    )
    trimmed = query.strip()
    if not trimmed:
        return name_filtered

    parsed = parse_search_query(query)
    if parsed.error:
        return []

    if sort_mode == "recent":
        filtered: list[SessionInfo] = []
        for session in name_filtered:
            result = match_session(session, parsed)
            if result.matches:
                filtered.append(session)
        return filtered

    scored: list[tuple[SessionInfo, float]] = []
    for session in name_filtered:
        result = match_session(session, parsed)
        if not result.matches:
            continue
        scored.append((session, result.score))

    def modified_timestamp(session: SessionInfo) -> float:
        modified = session.get("modified")
        if isinstance(modified, datetime):
            return modified.timestamp()
        return 0.0

    scored.sort(key=lambda item: (item[1], -modified_timestamp(item[0])))
    return [session for session, _score in scored]

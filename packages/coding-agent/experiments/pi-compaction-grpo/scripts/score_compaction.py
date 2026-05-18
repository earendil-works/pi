#!/usr/bin/env python3
"""Heuristic reward scorer for Pi compaction summaries.

Input is JSON on stdin or via --input:
{
  "source": "conversation text",
  "candidate": "summary text",
  "reference": "optional gold summary",
  "read_files": ["..."],
  "modified_files": ["..."],
  "critical_entities": ["..."]
}

Output is JSON with a 0..1 score and subscore breakdown.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path


SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.M)
PATH_RE = re.compile(r"(?:/[\w.\-+@]+)+|(?:[\w.\-+@]+/)+[\w.\-+@]+")
COMMAND_RE = re.compile(r"`([^`]{2,120})`|(?:^|\s)((?:python3|node|npm|pnpm|bun|cargo|git|rg|sed|b2|ce)\s+[^\n]{2,160})")
URL_RE = re.compile(r"https?://[^\s)>\"]+")
ID_RE = re.compile(r"\b[0-9a-f]{7,40}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b")
NUMBER_RE = re.compile(r"\b\d+(?:\.\d+)?%?\b")

STOP = {
    "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
    "is", "are", "was", "were", "be", "by", "as", "at", "from", "that",
    "this", "it", "its", "into", "not", "do", "does", "done", "you", "user",
}

CANONICAL_HEADINGS = [
    "goal",
    "constraints & preferences",
    "progress",
    "key decisions",
    "next steps",
    "critical context",
]

EXPECTED_SECTIONS = {
    "goal": ["goal"],
    "constraints": ["constraints", "preferences"],
    "progress": ["progress", "done", "in progress", "blocked"],
    "decisions": ["key decisions"],
    "next": ["next steps", "next actions"],
    "critical": ["critical context"],
}


def words(text: str) -> list[str]:
    return [w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9_\-]{2,}", text) if w.lower() not in STOP]


def ngrams(tokens: list[str], n: int) -> set[tuple[str, ...]]:
    if len(tokens) < n:
        return set()
    return {tuple(tokens[i : i + n]) for i in range(len(tokens) - n + 1)}


def f1(found: set[str], expected: set[str]) -> float:
    if not expected:
        return 1.0
    if not found:
        return 0.0
    tp = len(found & expected)
    precision = tp / max(len(found), 1)
    recall = tp / max(len(expected), 1)
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def extract_entities(text: str) -> set[str]:
    entities: set[str] = set()
    for regex in (PATH_RE, URL_RE, ID_RE):
        entities.update(m.group(0).strip(".,:;") for m in regex.finditer(text))
    for m in COMMAND_RE.finditer(text):
        entities.add((m.group(1) or m.group(2)).strip("` \t\n.,:;"))
    # Keep salient metrics and exact date/version-ish numbers.
    entities.update(m.group(0) for m in NUMBER_RE.finditer(text) if "%" in m.group(0) or len(m.group(0)) >= 3)
    filtered = set()
    for e in entities:
        if len(e) < 3:
            continue
        if "/" in e and not e.startswith(("/", "http")) and not re.search(r"[.\-+@]", e):
            continue
        filtered.add(e)
    return filtered


def source_keywords(source: str, limit: int = 60) -> set[str]:
    counts = Counter(words(source))
    return {w for w, _ in counts.most_common(limit)}


def section_score(candidate: str) -> float:
    headings = [h.lower().strip() for h in SECTION_RE.findall(candidate)]
    if not headings:
        return 0.0
    hits = 0
    for aliases in EXPECTED_SECTIONS.values():
        if any(any(alias in h for alias in aliases) for h in headings):
            hits += 1
    loose = hits / len(EXPECTED_SECTIONS)
    canonical_hits = sum(1 for h in CANONICAL_HEADINGS if h in headings)
    canonical = canonical_hits / len(CANONICAL_HEADINGS)
    # Pi's prompt asks for exact headings. Keep some tolerance for branch summaries
    # while making canonical structure measurably better.
    return 0.55 * loose + 0.45 * canonical


def section_text(candidate: str, heading: str) -> str:
    pattern = re.compile(rf"^##\s+{re.escape(heading)}\s*$", re.I | re.M)
    m = pattern.search(candidate)
    if not m:
        return ""
    next_m = SECTION_RE.search(candidate, m.end())
    return candidate[m.end() : next_m.start() if next_m else len(candidate)]


def lexical_coverage(source: str, candidate: str) -> float:
    src = source_keywords(source)
    cand = set(words(candidate))
    return f1(cand, src)


def entity_recall_precision(source: str, candidate: str, expected: set[str]) -> tuple[float, float, int]:
    if not expected:
        return 1.0, 1.0, 0
    cand_entities = extract_entities(candidate)
    hits = {e for e in expected if e in candidate}
    recall = len(hits) / max(len(expected), 1)
    # Precision only counts concrete entities that do not appear in the source
    # or as a more-specific form of an expected entity as risky.
    def supported(entity: str) -> bool:
        stripped = entity.strip("/")
        if entity in source or entity in expected:
            return True
        if stripped in {"read-files", "modified-files"}:
            return True
        return any(stripped and (stripped in exp.strip("/") or exp.strip("/") in stripped) for exp in expected)

    unsupported = {e for e in cand_entities if not supported(e)}
    precision = 1.0 if not cand_entities else 1.0 - (len(unsupported) / max(len(cand_entities), 1))
    return clamp(recall), clamp(precision), len(unsupported)


def reference_overlap(reference: str | None, candidate: str) -> float | None:
    if not reference:
        return None
    ref_tokens = words(reference)
    cand_tokens = words(candidate)
    if not ref_tokens:
        return None
    bi = f1({" ".join(x) for x in ngrams(cand_tokens, 2)}, {" ".join(x) for x in ngrams(ref_tokens, 2)})
    uni = f1(set(cand_tokens), set(ref_tokens))
    return 0.4 * uni + 0.6 * bi


def contains_any(text: str, terms: list[str]) -> bool:
    low = text.lower()
    return any(t in low for t in terms)


def actionability_score(candidate: str) -> float:
    next_section = section_text(candidate, "Next Steps")
    if not next_section:
        next_section = candidate
    numbered = len(re.findall(r"(?m)^\s*\d+\.\s+\S", next_section))
    imperative = len(re.findall(r"\b(run|retry|verify|inspect|sync|upload|evaluate|train|resume|archive|compare|fix|rerun)\b", next_section.lower()))
    concrete = len(extract_entities(next_section))
    return clamp(0.25 * min(numbered, 3) / 3 + 0.35 * min(imperative, 4) / 4 + 0.40 * min(concrete, 5) / 5)


def blocker_score(source: str, candidate: str) -> float:
    source_low = source.lower()
    cand_low = candidate.lower()
    blocker_terms = ["blocked", "blocker", "failed", "error", "oom", "permission denied", "not complete", "no adapter"]
    source_has = contains_any(source_low, blocker_terms)
    cand_has = contains_any(cand_low, blocker_terms)
    if not source_has:
        return 1.0 if not contains_any(cand_low, ["blocked by", "cannot proceed", "failed because"]) else 0.55
    if cand_has:
        return 1.0
    blocked_section = section_text(candidate, "Blocked").lower()
    if contains_any(cand_low, ["no blockers", "none known", "not blocked"]) or re.search(r"(?m)^\s*-\s*(none|none\.)\s*$", blocked_section):
        return 0.0
    return 0.35


def length_score(source: str, candidate: str) -> float:
    source_tokens = max(len(words(source)), 1)
    cand_tokens = len(words(candidate))
    ratio = cand_tokens / source_tokens
    if cand_tokens < 45:
        return cand_tokens / 45 * 0.45
    if source_tokens < 260 and cand_tokens < 420:
        return 0.85
    # Ideal compaction summary is often 4%-18% of the serialized source.
    if 0.04 <= ratio <= 0.18:
        return 1.0
    if ratio < 0.04:
        return clamp(ratio / 0.04)
    return clamp(1.0 - min((ratio - 0.18) / 0.35, 1.0))


def file_ops_score(candidate: str, read_files: list[str], modified_files: list[str]) -> float:
    expected_read = set(read_files)
    expected_mod = set(modified_files)
    if not expected_read and not expected_mod:
        return 1.0
    read_block = set()
    mod_block = set()
    m = re.search(r"<read-files>\s*(.*?)\s*</read-files>", candidate, re.S)
    if m:
        read_block = {x.strip() for x in m.group(1).splitlines() if x.strip()}
    m = re.search(r"<modified-files>\s*(.*?)\s*</modified-files>", candidate, re.S)
    if m:
        mod_block = {x.strip() for x in m.group(1).splitlines() if x.strip()}
    if not read_block and not mod_block:
        # Fall back to mention detection, but cap because XML tags matter in Pi.
        mentioned = {p for p in expected_read | expected_mod if p in candidate}
        return 0.55 * f1(mentioned, expected_read | expected_mod)
    return 0.45 * f1(read_block, expected_read) + 0.55 * f1(mod_block, expected_mod)


def continuation_penalty(candidate: str) -> float:
    low = candidate.lower()
    penalty = 0.0
    if contains_any(low, ["i can help", "sure,", "here is the answer", "let me know", "would you like"]):
        penalty += 0.08
    if re.search(r"(?m)^\s*(assistant|user)\s*:", candidate, re.I):
        penalty += 0.08
    return min(0.16, penalty)


def malformed_text_penalty(candidate: str) -> float:
    """Penalize tokenizer-noise / encoded junk that can otherwise carry entities."""
    head = candidate[:240]
    penalty = 0.0
    if re.search(r"%20|&nbsp;|&#\d+;", head):
        penalty += 0.08
    if re.search(r"[#A-Za-z ]*[).&'+,/0-9\\-]{6,}", head):
        penalty += 0.10
    if re.search(r"(?m)^(?:Goal|Constraints & Preferences|Progress|Key Decisions|Next Steps|Critical Context)\s*$", candidate):
        # Pi summaries should use exact markdown headings (`## Goal`, etc.).
        penalty += 0.08
    if re.search(r"(?m)^#{1,3}\s*Pi[^A-Za-z\n]{3,}", candidate):
        penalty += 0.08
    return min(0.22, penalty)


def exact_heading_penalty(candidate: str, structure: float) -> float:
    headings = {h.lower().strip() for h in SECTION_RE.findall(candidate)}
    exact = sum(1 for h in CANONICAL_HEADINGS if h in headings)
    if exact == len(CANONICAL_HEADINGS):
        return 0.0
    if exact >= 4:
        return 0.04
    if structure >= 0.45:
        return 0.08
    return 0.14


def score_payload(payload: dict) -> dict:
    source = payload.get("source", "")
    candidate = payload.get("candidate", "")
    reference = payload.get("reference") or None
    read_files = payload.get("read_files") or []
    modified_files = payload.get("modified_files") or []
    critical_entities = set(payload.get("critical_entities") or []) | extract_entities(source)

    cand_low = candidate.lower()
    ref_overlap = reference_overlap(reference, candidate)
    coverage = lexical_coverage(source, candidate)
    entity_recall, entity_precision, unsupported_entities = entity_recall_precision(source, candidate, critical_entities)
    entity = 0.75 * entity_recall + 0.25 * entity_precision

    goal = max(
        0.35 * coverage + 0.65 * float(contains_any(cand_low, ["goal", "objective", "trying to", "wants"])),
        ref_overlap or 0.0,
    )
    constraints = 0.55 * float(contains_any(cand_low, ["constraint", "preference", "must", "never", "require"])) + 0.45 * coverage
    blocker = blocker_score(source, candidate)
    progress = 0.35 * float(contains_any(cand_low, ["done", "completed", "in progress", "blocked", "failed"])) + 0.35 * coverage + 0.30 * blocker
    actionability = actionability_score(candidate)
    next_actions = 0.55 * float(contains_any(cand_low, ["next", "continue", "resume", "then", "1."])) + 0.45 * actionability
    recency = 0.4 * float(contains_any(cand_low, ["current", "latest", "now", "resume", "next"])) + 0.35 * coverage + 0.25 * blocker
    structure = section_score(candidate)
    compression = length_score(source, candidate)
    file_ops = file_ops_score(candidate, read_files, modified_files)

    subscores = {
        "goal_and_intent": clamp(goal),
        "constraints_and_preferences": clamp(constraints),
        "progress_state": clamp(progress),
        "next_actions": clamp(next_actions),
        "critical_entities": clamp(entity),
        "entity_precision": clamp(entity_precision),
        "file_operations": clamp(file_ops),
        "blocker_fidelity": clamp(blocker),
        "actionability": clamp(actionability),
        "recency": clamp(recency),
        "structure": clamp(structure),
        "compression": clamp(compression),
    }

    weights = {
        "goal_and_intent": 0.14,
        "constraints_and_preferences": 0.10,
        "progress_state": 0.15,
        "next_actions": 0.12,
        "critical_entities": 0.12,
        "entity_precision": 0.05,
        "file_operations": 0.08,
        "blocker_fidelity": 0.06,
        "actionability": 0.06,
        "recency": 0.06,
        "structure": 0.05,
        "compression": 0.01,
    }

    score = sum(subscores[k] * weights[k] for k in weights)
    penalties: dict[str, float] = {}

    if len(words(candidate)) < 25:
        penalties["empty_or_too_short"] = 0.30
    if structure > 0.7 and coverage < 0.08 and entity < 0.15:
        penalties["heading_only_generic"] = 0.16
    if structure > 0.7 and actionability < 0.20 and entity_recall < 0.35:
        penalties["structured_but_vague"] = 0.10
    if compression < 0.25 and coverage < 0.12:
        penalties["overcompressed"] = 0.12
    if unsupported_entities >= 3:
        penalties["unsupported_entity_stuffing"] = min(0.16, 0.04 * unsupported_entities)
    heading_penalty = exact_heading_penalty(candidate, structure)
    if heading_penalty:
        penalties["missing_exact_pi_headings"] = heading_penalty
    malformed_penalty = malformed_text_penalty(candidate)
    if malformed_penalty:
        penalties["malformed_or_encoded_output"] = malformed_penalty
    if entity_recall > 0.45 and (progress < 0.35 or next_actions < 0.35):
        penalties["entity_stuffing_without_state"] = 0.10
    if file_ops < 0.35 and (read_files or modified_files):
        penalties["missing_file_operation_tags"] = 0.08
    cont_penalty = continuation_penalty(candidate)
    if cont_penalty:
        penalties["continues_conversation_instead_of_summary"] = cont_penalty
    if reference:
        cand_only_numbers = set(NUMBER_RE.findall(candidate)) - set(NUMBER_RE.findall(source))
        if cand_only_numbers:
            penalties["candidate_numbers_not_in_source"] = min(0.12, 0.03 * len(cand_only_numbers))
    # Contradiction-ish heuristic for false completion.
    if "blocked" in source.lower() and contains_any(cand_low, ["no blockers", "not blocked", "unblocked"]):
        penalties["missed_blocker"] = 0.12
    if contains_any(cand_low, ["project is complete", "finished all", "all experiments", "mark the goal complete"]):
        if contains_any(source.lower(), ["in progress", "not complete", "failed", "blocked", "no adapter", "no baseline"]):
            penalties["hallucinated_completion"] = 0.20
    if contains_any(cand_low, ["no blockers", "none."]) and contains_any(source.lower(), ["blocked:", "blocked -", "blocker"]):
        penalties["false_no_blockers"] = max(penalties.get("false_no_blockers", 0.0), 0.10)

    total_penalty = sum(penalties.values())
    final = clamp(score - total_penalty)
    return {
        "score": final,
        "raw_score": score,
        "penalty": total_penalty,
        "subscores": subscores,
        "penalties": penalties,
        "stats": {
            "source_words": len(words(source)),
            "candidate_words": len(words(candidate)),
            "critical_entities": len(critical_entities),
            "critical_entity_hits": sum(1 for e in critical_entities if e in candidate),
            "unsupported_entities": unsupported_entities,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path)
    args = ap.parse_args()
    raw = args.input.read_text() if args.input else sys.stdin.read()
    payload = json.loads(raw)
    print(json.dumps(score_payload(payload), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

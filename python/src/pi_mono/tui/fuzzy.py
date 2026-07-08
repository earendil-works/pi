import re
from typing import Callable, List, TypeVar

T = TypeVar("T")


class FuzzyMatch:
    """
    Represents the result of a fuzzy match.
    """

    def __init__(self, matches: bool, score: float):
        self.matches = matches
        self.score = score


def fuzzy_match(query: str, text: str) -> FuzzyMatch:
    """
    Fuzzy matching utility.
    Matches if all query characters appear in order (not necessarily consecutive).
    Lower score = better match.
    """
    query_lower = query.lower()
    text_lower = text.lower()

    def match_query(normalized_query: str) -> FuzzyMatch:
        if len(normalized_query) == 0:
            return FuzzyMatch(True, 0.0)

        if len(normalized_query) > len(text_lower):
            return FuzzyMatch(False, 0.0)

        query_index = 0
        score = 0.0
        last_match_index = -1
        consecutive_matches = 0

        for i in range(len(text_lower)):
            if query_index >= len(normalized_query):
                break

            if text_lower[i] == normalized_query[query_index]:
                # Word boundary check
                is_word_boundary = i == 0 or bool(re.match(r"[\s\-_./:]", text_lower[i - 1]))

                # Reward consecutive matches
                if last_match_index == i - 1:
                    consecutive_matches += 1
                    score -= consecutive_matches * 5
                else:
                    consecutive_matches = 0
                    # Penalize gaps
                    if last_match_index >= 0:
                        score += (i - last_match_index - 1) * 2

                # Reward word boundary matches
                if is_word_boundary:
                    score -= 10

                # Slight penalty for later matches
                score += i * 0.1

                last_match_index = i
                query_index += 1

        if query_index < len(normalized_query):
            return FuzzyMatch(False, 0.0)

        if normalized_query == text_lower:
            score -= 100

        return FuzzyMatch(True, score)

    primary_match = match_query(query_lower)
    if primary_match.matches:
        return primary_match

    alpha_numeric_match = re.match(r"^(?P<letters>[a-z]+)(?P<digits>[0-9]+)$", query_lower)
    numeric_alpha_match = re.match(r"^(?P<digits>[0-9]+)(?P<letters>[a-z]+)$", query_lower)

    if alpha_numeric_match:
        swapped_query = (
            f"{alpha_numeric_match.group('digits')}{alpha_numeric_match.group('letters')}"
        )
    elif numeric_alpha_match:
        swapped_query = (
            f"{numeric_alpha_match.group('letters')}{numeric_alpha_match.group('digits')}"
        )
    else:
        swapped_query = ""

    if not swapped_query:
        return primary_match

    swapped_match = match_query(swapped_query)
    if not swapped_match.matches:
        return primary_match

    return FuzzyMatch(True, swapped_match.score + 5)


def fuzzy_filter(items: List[T], query: str, get_text: Callable[[T], str]) -> List[T]:
    """
    Filter and sort items by fuzzy match quality (best matches first).
    Supports space-separated tokens: all tokens must match.
    """
    trimmed_query = query.strip()
    if not trimmed_query:
        return items

    tokens = [t for t in re.split(r"[\s/]+", trimmed_query) if len(t) > 0]
    if not tokens:
        return items

    results = []

    for item in items:
        text = get_text(item)
        total_score = 0.0
        all_match = True

        for token in tokens:
            match = fuzzy_match(token, text)
            if match.matches:
                total_score += match.score
            else:
                all_match = False
                break

        if all_match:
            results.append((item, total_score))

    # Sort in ascending order (lower score is better match)
    results.sort(key=lambda x: x[1])
    return [r[0] for r in results]

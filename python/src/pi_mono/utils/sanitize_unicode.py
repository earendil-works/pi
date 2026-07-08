import re


def sanitize_surrogates(text: str) -> str:
    """Removes unpaired Unicode surrogate characters from a string.

    Unpaired surrogates (high surrogates 0xD800-0xDBFF without matching low surrogates 0xDC00-0xDFFF,
    or vice versa) cause JSON serialization errors in many API providers.

    Valid emoji and other characters outside the Basic Multilingual Plane use properly paired
    surrogates and will NOT be affected by this function.
    """
    # Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
    # Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
    pattern = re.compile(r"[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]")
    return pattern.sub("", text)

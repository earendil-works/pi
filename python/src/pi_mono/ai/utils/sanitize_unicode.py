"""Unicode sanitization utilities."""

import re


def sanitize_surrogates(text: str) -> str:
    """
    Removes unpaired Unicode surrogate characters from a string.

    Unpaired surrogates (high surrogates 0xD800-0xDBFF without matching low
    surrogates 0xDC00-0xDFFF, or vice versa) cause JSON serialization errors
    in many API providers.

    Valid emoji and other characters outside the Basic Multilingual Plane use
    properly paired surrogates and will NOT be affected by this function.

    Args:
        text: The text to sanitize

    Returns:
        The sanitized text with unpaired surrogates removed

    Examples:
        # Valid emoji (properly paired surrogates) are preserved
        sanitize_surrogates("Hello 🙈 World")  # => "Hello 🙈 World"

        # Unpaired high surrogate is removed
        unpaired = chr(0xD83D)  # high surrogate without low
        sanitize_surrogates(f"Text {unpaired} here")  # => "Text  here"
    """
    # Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
    # Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
    # Python handles this differently since it uses full Unicode code points internally
    # This regex matches the UTF-16 surrogate pair pattern in a Python string
    return re.sub(
        r"[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?![\uD800-\uDBFF])[\uDC00-\uDFFF]",
        "",
        text,
    )


def sanitize_unicode_for_json(text: str) -> str:
    """
    Sanitize a string for JSON serialization by removing characters that would
    cause encoding errors.
    """
    # Remove unpaired surrogates
    text = sanitize_surrogates(text)

    # Remove other problematic control characters that might cause issues
    # Keep standard whitespace: \t, \n, \r
    # Remove: \x00-\x08, \x0B-\x0C, \x0E-\x1F, \x7F
    result = []
    for char in text:
        code = ord(char)
        if code in (0x09, 0x0A, 0x0D):  # \t, \n, \r
            result.append(char)
        elif code <= 0x1F or code == 0x7F:
            # Skip other control characters
            continue
        else:
            result.append(char)

    return "".join(result)

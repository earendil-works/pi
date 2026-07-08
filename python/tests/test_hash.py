from pi_mono.utils.hash import short_hash


def test_short_hash_matches_typescript_outputs():
    # Empty string
    assert short_hash("") == "k4n83c7h0j2b"
    # Basic string
    assert short_hash("hello") == "1h6qa0qrowduu"
    # Long string
    assert short_hash("a" * 1000) == "kli8eammh8ym"
    # Emojis (non-BMP characters with surrogate pairs in JS)
    assert short_hash("🙈") == "kphsz0153ms3q"
    assert short_hash("Hello 🙈 World") == "11begrz17n9aby"

import re
from unittest.mock import patch

from pi_mono.agent.harness.session.uuid import uuidv7

UUID_V7_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TIMESTAMP = 0x0123456789AB / 1000.0  # since time.time() returns seconds


def parse_timestamp(uuid_str: str) -> int:
    return int(uuid_str.replace("-", "")[:12], 16)


def test_uuidv7_layout_and_monotonicity():
    random_values = [
        bytes([0, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFE, 0x01, 0x11, 0x22, 0x33, 0x44, 0x55]),
        bytes(16),
        bytes(16),
    ]

    def mock_token_bytes(n):
        if random_values:
            return random_values.pop(0)
        return bytes(n)

    import pi_mono.agent.harness.session.uuid as uuid_mod

    uuid_mod.last_timestamp = -1
    uuid_mod.sequence = 0

    with (
        patch("secrets.token_bytes", side_effect=mock_token_bytes),
        patch("time.time", return_value=TIMESTAMP),
    ):

        first = uuidv7()
        second = uuidv7()
        third = uuidv7()

        assert first == "01234567-89ab-7fff-bfff-f91122334455"
        assert second == "01234567-89ab-7fff-bfff-fc0000000000"
        assert third == "01234567-89ac-7000-8000-000000000000"

        assert UUID_V7_RE.match(first)
        assert UUID_V7_RE.match(second)
        assert UUID_V7_RE.match(third)

        assert parse_timestamp(first) == int(TIMESTAMP * 1000)
        assert parse_timestamp(second) == int(TIMESTAMP * 1000)
        assert parse_timestamp(third) == int(TIMESTAMP * 1000) + 1

        assert first < second
        assert second < third

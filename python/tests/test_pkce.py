import re

import pytest

from pi_mono.ai.utils.oauth.pkce import generate_pkce


@pytest.mark.anyio
async def test_generate_pkce_returns_verifier_and_challenge():
    pkce = await generate_pkce()
    assert isinstance(pkce["verifier"], str)
    assert isinstance(pkce["challenge"], str)
    assert pkce["verifier"] != pkce["challenge"]
    assert re.fullmatch(r"[A-Za-z0-9_-]+", pkce["verifier"])
    assert re.fullmatch(r"[A-Za-z0-9_-]+", pkce["challenge"])

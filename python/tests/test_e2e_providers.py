"""Gated real-provider e2e tests (mirrors TS vitest env-var gating)."""

from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.e2e


@pytest.fixture(scope="session")
def e2e_provider() -> str:
    provider = os.environ.get("PI_E2E_PROVIDER", "").strip()
    if not provider:
        pytest.skip("Set PI_E2E_PROVIDER to run real-provider e2e tests")
    return provider


def test_e2e_provider_env_is_configured(e2e_provider: str) -> None:
    assert e2e_provider

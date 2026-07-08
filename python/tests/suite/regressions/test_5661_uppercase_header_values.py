"""Regression #5661: uppercase models.json values remain literals."""

from __future__ import annotations

import json

import pytest

from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.model_registry import ModelRegistry


@pytest.mark.anyio
async def test_uppercase_api_key_and_header_values_remain_literals(tmp_path, monkeypatch) -> None:
    for key in ("CUSTOM_API_KEY", "BEARER"):
        monkeypatch.setenv(key, f"env-{key}")

    models_path = tmp_path / "models.json"
    models_path.write_text(
        json.dumps(
            {
                "providers": {
                    "my-provider": {
                        "baseUrl": "https://example.com/v1",
                        "apiKey": "CUSTOM_API_KEY",
                        "api": "openai-completions",
                        "headers": {"Authorization": "BEARER"},
                        "models": [{"id": "my-model"}],
                    }
                }
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    registry = ModelRegistry.create(
        AuthStorage.create(str(tmp_path / "auth.json")),
        str(models_path),
    )
    model = registry.find("my-provider", "my-model")
    assert model is not None

    auth = await registry.get_api_key_and_headers(model)
    assert auth["ok"] is True
    assert auth["apiKey"] == "CUSTOM_API_KEY"
    assert auth["headers"] == {"Authorization": "BEARER"}

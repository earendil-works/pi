"""Experimental feature flags."""

from __future__ import annotations

import os


def are_experimental_features_enabled() -> bool:
    value = os.environ.get("PI_EXPERIMENTAL", "")
    return value == "1" or value.lower() in ("true", "yes")

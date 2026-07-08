"""Source metadata for resources and extensions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict

SourceScope = Literal["user", "project", "temporary"]
SourceOrigin = Literal["package", "top-level"]


class PathMetadata(TypedDict, total=False):
    source: str
    scope: SourceScope
    origin: SourceOrigin
    baseDir: str


@dataclass(frozen=True)
class SourceInfo:
    path: str
    source: str
    scope: SourceScope
    origin: SourceOrigin
    base_dir: str | None = None


def create_source_info(path: str, metadata: PathMetadata) -> SourceInfo:
    return SourceInfo(
        path=path,
        source=metadata["source"],
        scope=metadata.get("scope", "temporary"),
        origin=metadata.get("origin", "top-level"),
        base_dir=metadata.get("baseDir"),
    )


def create_synthetic_source_info(
    path: str,
    *,
    source: str,
    scope: SourceScope = "temporary",
    origin: SourceOrigin = "top-level",
    base_dir: str | None = None,
) -> SourceInfo:
    return SourceInfo(
        path=path,
        source=source,
        scope=scope,
        origin=origin,
        base_dir=base_dir,
    )

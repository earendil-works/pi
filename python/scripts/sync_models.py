#!/usr/bin/env python3
"""Sync generated model catalogs from the TypeScript ai package into the Python port."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

_CATALOGS: tuple[tuple[str, str], ...] = (
    ("models.generated", "MODELS"),
    ("image-models.generated", "IMAGE_MODELS"),
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _tsx_executable(root: Path) -> str:
    local_tsx = root / "node_modules" / ".bin" / "tsx"
    if local_tsx.is_file():
        return str(local_tsx)
    found = shutil.which("tsx")
    if found:
        return found
    raise FileNotFoundError("tsx is required to export TypeScript model catalogs")


def export_ts_catalog(ts_path: Path, export_name: str) -> bytes:
    root = _repo_root()
    tsx = _tsx_executable(root)
    script = (
        f'import {{ {export_name} }} from "{ts_path.as_posix()}"; '
        f"process.stdout.write(JSON.stringify({export_name}));"
    )
    result = subprocess.run(
        [tsx, "-e", script],
        cwd=root,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"Failed to export {export_name} from {ts_path.name}"
            + (f": {stderr}" if stderr else "")
        )
    json.loads(result.stdout)
    return result.stdout


def resolve_catalog_source(
    stem: str, export_name: str, *, root: Path | None = None
) -> tuple[Path, str | None]:
    package_src = (root or _repo_root()) / "packages" / "ai" / "src"
    json_path = package_src / f"{stem}.json"
    if json_path.is_file():
        return json_path, None
    ts_path = package_src / f"{stem}.ts"
    if ts_path.is_file():
        return ts_path, export_name
    raise FileNotFoundError(f"Missing source catalog for {stem}")


def read_catalog_bytes(source: Path, export_name: str | None) -> bytes:
    if export_name is None:
        return source.read_bytes()
    return export_ts_catalog(source, export_name)


def sync_models(*, check: bool = False) -> int:
    root = _repo_root()
    changed = False
    for stem, export_name in _CATALOGS:
        source, ts_export = resolve_catalog_source(stem, export_name, root=root)
        destination = root / "python" / "src" / "pi_mono" / "ai" / f"{stem}.json"
        source_bytes = read_catalog_bytes(source, ts_export)
        if destination.is_file() and destination.read_bytes() == source_bytes:
            continue
        changed = True
        if check:
            print(f"out of date: {destination}")
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source_bytes)
        print(f"synced {source.name} -> {destination}")

    if check and changed:
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit 1 if Python catalogs differ from the TypeScript sources.",
    )
    args = parser.parse_args()
    raise SystemExit(sync_models(check=args.check))


if __name__ == "__main__":
    main()

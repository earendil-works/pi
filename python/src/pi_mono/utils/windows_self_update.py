"""Windows npm self-update quarantine for native addon files."""

from __future__ import annotations

import os
import shutil
import sys
import time
import uuid
from pathlib import Path

QUARANTINE_DIR_NAME = ".pi-native-quarantine"


def _normalize_path(path: str) -> str:
    return str(Path(path).resolve())


def _get_quarantine_root(package_dir: str) -> str | None:
    current = Path(package_dir).resolve()
    while True:
        if current.name.lower() == "node_modules":
            return str(current / QUARANTINE_DIR_NAME)
        if current.parent == current:
            return None
        current = current.parent


def cleanup_windows_self_update_quarantine(package_dir: str) -> None:
    if sys.platform != "win32":
        return
    quarantine_root = _get_quarantine_root(package_dir)
    if not quarantine_root:
        return
    try:
        shutil.rmtree(quarantine_root, ignore_errors=True)
    except OSError:
        pass


def quarantine_windows_native_dependencies(package_dir: str) -> None:
    """Best-effort quarantine for loaded native modules under package_dir on Windows."""
    if sys.platform != "win32":
        return

    resolved_package_dir = _normalize_path(package_dir).lower()
    loaded_files: list[str] = []
    for module_name, module in sys.modules.items():
        del module_name
        module_file = getattr(module, "__file__", None)
        if not module_file:
            continue
        normalized = _normalize_path(module_file).lower()
        if normalized.startswith(resolved_package_dir) and normalized.endswith((".pyd", ".dll")):
            loaded_files.append(_normalize_path(module_file))

    quarantine_root = _get_quarantine_root(package_dir)
    if not quarantine_root or not loaded_files:
        return

    quarantine_run_dir = os.path.join(
        quarantine_root,
        f"{int(time.time() * 1000)}-{os.getpid()}-{uuid.uuid4()}",
    )
    for loaded_file in loaded_files:
        if not os.path.isfile(loaded_file):
            continue
        relative_path = os.path.relpath(loaded_file, package_dir)
        quarantine_path = os.path.join(quarantine_run_dir, relative_path)
        os.makedirs(os.path.dirname(quarantine_path), exist_ok=True)
        try:
            os.replace(loaded_file, quarantine_path)
            shutil.copy2(quarantine_path, loaded_file)
        except OSError:
            continue

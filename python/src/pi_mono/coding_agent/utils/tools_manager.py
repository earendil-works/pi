"""Managed external tool discovery and download (fd, rg)."""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.request import Request, urlopen

from pi_mono.config import APP_NAME, get_bin_dir

ToolName = str

NETWORK_TIMEOUT_S = 10.0
DOWNLOAD_TIMEOUT_S = 120.0

_FD_SYSTEM_NAMES = ("fd", "fdfind")
_RG_SYSTEM_NAMES = ("rg",)

TERMUX_PACKAGES = {"fd": "fd", "rg": "ripgrep"}


@dataclass(frozen=True)
class ToolConfig:
    name: str
    repo: str
    binary_name: str
    system_binary_names: tuple[str, ...]
    tag_prefix: str
    get_asset_name: Callable[[str, str, str], str | None]


def _is_offline_mode_enabled() -> bool:
    value = os.environ.get("PI_OFFLINE", "")
    return value in ("1", "true", "True", "yes", "YES")


def _command_exists(command: str) -> bool:
    if shutil.which(command) is None:
        return False
    try:
        completed = subprocess.run(
            [command, "--version"],
            capture_output=True,
            check=False,
        )
        return completed.returncode == 0
    except OSError:
        return False


def _get_latest_version(repo: str) -> str:
    request = Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={"User-Agent": f"{APP_NAME}-coding-agent"},
    )
    with urlopen(request, timeout=NETWORK_TIMEOUT_S) as response:
        import json

        data = json.loads(response.read().decode("utf-8"))
    tag = str(data.get("tag_name", ""))
    return tag.removeprefix("v")


def _download_file(url: str, dest: str) -> None:
    request = Request(url, headers={"User-Agent": f"{APP_NAME}-coding-agent"})
    with urlopen(request, timeout=DOWNLOAD_TIMEOUT_S) as response, open(dest, "wb") as handle:
        while True:
            chunk = response.read(1024 * 64)
            if not chunk:
                break
            handle.write(chunk)


def _find_binary_recursively(root_dir: str, binary_name: str) -> str | None:
    for root, _dirs, files in os.walk(root_dir):
        if binary_name in files:
            return os.path.join(root, binary_name)
    return None


def _extract_archive(archive_path: str, extract_dir: str) -> None:
    if archive_path.endswith(".tar.gz"):
        with tarfile.open(archive_path, "r:gz") as archive:
            archive.extractall(extract_dir)
        return
    if archive_path.endswith(".zip"):
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(extract_dir)
        return
    raise RuntimeError(f"Unsupported archive format: {archive_path}")


TOOLS: dict[str, ToolConfig] = {
    "fd": ToolConfig(
        name="fd",
        repo="sharkdp/fd",
        binary_name="fd",
        system_binary_names=_FD_SYSTEM_NAMES,
        tag_prefix="v",
        get_asset_name=lambda version, plat, arch: (
            f"fd-v{version}-aarch64-apple-darwin.tar.gz"
            if plat == "darwin" and arch == "arm64"
            else (
                f"fd-v{version}-x86_64-apple-darwin.tar.gz"
                if plat == "darwin"
                else (
                    f"fd-v{version}-aarch64-unknown-linux-gnu.tar.gz"
                    if plat == "linux" and arch == "arm64"
                    else (
                        f"fd-v{version}-x86_64-unknown-linux-gnu.tar.gz"
                        if plat == "linux"
                        else (
                            f"fd-v{version}-aarch64-pc-windows-msvc.zip"
                            if plat == "win32" and arch == "arm64"
                            else (
                                f"fd-v{version}-x86_64-pc-windows-msvc.zip"
                                if plat == "win32"
                                else None
                            )
                        )
                    )
                )
            )
        ),
    ),
    "rg": ToolConfig(
        name="ripgrep",
        repo="BurntSushi/ripgrep",
        binary_name="rg",
        system_binary_names=_RG_SYSTEM_NAMES,
        tag_prefix="",
        get_asset_name=lambda version, plat, arch: (
            f"ripgrep-{version}-aarch64-apple-darwin.tar.gz"
            if plat == "darwin" and arch == "arm64"
            else (
                f"ripgrep-{version}-x86_64-apple-darwin.tar.gz"
                if plat == "darwin"
                else (
                    f"ripgrep-{version}-aarch64-unknown-linux-gnu.tar.gz"
                    if plat == "linux" and arch == "arm64"
                    else (
                        f"ripgrep-{version}-x86_64-unknown-linux-musl.tar.gz"
                        if plat == "linux"
                        else (
                            f"ripgrep-{version}-aarch64-pc-windows-msvc.zip"
                            if plat == "win32" and arch == "arm64"
                            else (
                                f"ripgrep-{version}-x86_64-pc-windows-msvc.zip"
                                if plat == "win32"
                                else None
                            )
                        )
                    )
                )
            )
        ),
    ),
}


def get_tool_path(tool: ToolName) -> str | None:
    """Return a local or system path for fd/rg, or None if unavailable."""
    config = TOOLS.get(tool)
    if config is None:
        return None

    bin_dir = str(get_bin_dir())
    binary_ext = ".exe" if sys.platform == "win32" else ""
    local_path = os.path.join(bin_dir, config.binary_name + binary_ext)
    if os.path.isfile(local_path):
        return local_path

    for name in config.system_binary_names:
        if _command_exists(name):
            return name
    return None


async def _download_tool(tool: ToolName) -> str:
    config = TOOLS.get(tool)
    if config is None:
        raise RuntimeError(f"Unknown tool: {tool}")

    plat = sys.platform
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x86_64"

    version = await __import__("asyncio").to_thread(_get_latest_version, config.repo)
    if tool == "fd" and plat == "darwin" and arch == "x86_64":
        version = "10.3.0"

    asset_name = config.get_asset_name(version, plat, arch)
    if not asset_name:
        raise RuntimeError(f"Unsupported platform: {plat}/{arch}")

    bin_dir = Path(get_bin_dir())
    bin_dir.mkdir(parents=True, exist_ok=True)
    binary_ext = ".exe" if plat == "win32" else ""
    binary_path = bin_dir / f"{config.binary_name}{binary_ext}"

    download_url = (
        f"https://github.com/{config.repo}/releases/download/"
        f"{config.tag_prefix}{version}/{asset_name}"
    )
    archive_path = bin_dir / asset_name
    await __import__("asyncio").to_thread(_download_file, download_url, str(archive_path))

    extract_dir = tempfile.mkdtemp(
        prefix=f"extract_{config.binary_name}_{os.getpid()}_{int(time.time())}_",
        dir=str(bin_dir),
    )
    try:
        await __import__("asyncio").to_thread(_extract_archive, str(archive_path), extract_dir)
        binary_file_name = config.binary_name + binary_ext
        extracted_binary = _find_binary_recursively(extract_dir, binary_file_name)
        if not extracted_binary:
            raise RuntimeError(f"Binary not found in archive: {binary_file_name}")
        shutil.move(extracted_binary, binary_path)
        if plat != "win32":
            os.chmod(binary_path, 0o755)
    finally:
        archive_path.unlink(missing_ok=True)
        shutil.rmtree(extract_dir, ignore_errors=True)

    return str(binary_path)


async def ensure_tool(tool: ToolName, silent: bool = False) -> str | None:
    """Ensure fd/rg is available, downloading from GitHub releases when needed."""
    existing = get_tool_path(tool)
    if existing:
        return existing

    config = TOOLS.get(tool)
    if config is None:
        return None

    if _is_offline_mode_enabled():
        if not silent:
            print(f"{config.name} not found. Offline mode enabled, skipping download.")
        return None

    if sys.platform == "android":
        pkg_name = TERMUX_PACKAGES.get(tool, tool)
        if not silent:
            print(f"{config.name} not found. Install with: pkg install {pkg_name}")
        return None

    if not silent:
        print(f"Downloading {config.name}...")
    try:
        return await _download_tool(tool)
    except Exception as error:
        if not silent:
            print(f"Failed to download {config.name}: {error}")
        return None

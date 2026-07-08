"""Clipboard image detection across platforms."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from io import BytesIO

SUPPORTED_IMAGE_MIME_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")
DEFAULT_LIST_TIMEOUT_SECONDS = 1.0
DEFAULT_READ_TIMEOUT_SECONDS = 3.0
DEFAULT_POWERSHELL_TIMEOUT_SECONDS = 5.0
DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024
MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024


@dataclass
class ClipboardImage:
    bytes: bytes
    mime_type: str


def _base_mime_type(mime_type: str) -> str:
    return mime_type.split(";", 1)[0].strip().lower()


def extension_for_image_mime_type(mime_type: str) -> str | None:
    match _base_mime_type(mime_type):
        case "image/png":
            return "png"
        case "image/jpeg":
            return "jpg"
        case "image/webp":
            return "webp"
        case "image/gif":
            return "gif"
        case _:
            return None


def is_wayland_session(env: dict[str, str] | None = None) -> bool:
    values = env or os.environ
    return bool(values.get("WAYLAND_DISPLAY")) or values.get("XDG_SESSION_TYPE") == "wayland"


def _select_preferred_image_mime_type(mime_types: list[str]) -> str | None:
    normalized = [
        {"raw": item.strip(), "base": _base_mime_type(item)} for item in mime_types if item.strip()
    ]
    for preferred in SUPPORTED_IMAGE_MIME_TYPES:
        match = next((item for item in normalized if item["base"] == preferred), None)
        if match:
            return match["raw"]
    any_image = next((item for item in normalized if item["base"].startswith("image/")), None)
    return any_image["raw"] if any_image else None


def _is_supported_image_mime_type(mime_type: str) -> bool:
    base = _base_mime_type(mime_type)
    return base in SUPPORTED_IMAGE_MIME_TYPES


def _run_command(
    command: list[str],
    *,
    timeout_seconds: float = DEFAULT_READ_TIMEOUT_SECONDS,
    env: dict[str, str] | None = None,
) -> bytes | None:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            timeout=timeout_seconds,
            env=env,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    if len(result.stdout) > DEFAULT_MAX_BUFFER_BYTES:
        return None
    return result.stdout


def _convert_to_png(image_bytes: bytes) -> bytes | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            output = BytesIO()
            image.save(output, format="PNG")
            return output.getvalue()
    except Exception:
        return None


def _read_clipboard_image_via_wl_paste() -> ClipboardImage | None:
    listed = _run_command(
        ["wl-paste", "--list-types"], timeout_seconds=DEFAULT_LIST_TIMEOUT_SECONDS
    )
    if listed is None:
        return None
    types = [
        line.strip()
        for line in listed.decode("utf-8", errors="replace").splitlines()
        if line.strip()
    ]
    selected_type = _select_preferred_image_mime_type(types)
    if not selected_type:
        return None
    data = _run_command(["wl-paste", "--type", selected_type, "--no-newline"])
    if not data:
        return None
    return ClipboardImage(bytes=data, mime_type=_base_mime_type(selected_type))


def _is_wsl(env: dict[str, str] | None = None) -> bool:
    values = env or os.environ
    if values.get("WSL_DISTRO_NAME") or values.get("WSLENV"):
        return True
    try:
        with open("/proc/version", encoding="utf-8") as handle:
            return bool(re.search(r"microsoft|wsl", handle.read(), re.IGNORECASE))
    except OSError:
        return False


def _read_clipboard_image_via_powershell(*, win_path: str) -> ClipboardImage | None:
    ps_quoted = win_path.replace("'", "''")
    ps_script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "Add-Type -AssemblyName System.Drawing; "
        f"$path = '{ps_quoted}'; "
        "$img = [System.Windows.Forms.Clipboard]::GetImage(); "
        "if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } "
        "else { Write-Output 'empty' }"
    )
    result = _run_command(
        ["powershell.exe", "-NoProfile", "-Command", ps_script],
        timeout_seconds=DEFAULT_POWERSHELL_TIMEOUT_SECONDS,
    )
    if result is None or result.decode("utf-8", errors="replace").strip() != "ok":
        return None
    try:
        with open(win_path, "rb") as handle:
            data = handle.read()
    except OSError:
        return None
    if not data:
        return None
    return ClipboardImage(bytes=data, mime_type="image/png")


def _read_clipboard_image_via_wsl_powershell() -> ClipboardImage | None:
    tmp_file = os.path.join(tempfile.gettempdir(), f"pi-wsl-clip-{uuid.uuid4()}.png")
    try:
        win_path = _run_command(
            ["wslpath", "-w", tmp_file], timeout_seconds=DEFAULT_LIST_TIMEOUT_SECONDS
        )
        if not win_path:
            return None
        win_path_text = win_path.decode("utf-8", errors="replace").strip()
        if not win_path_text:
            return None
        return _read_clipboard_image_via_powershell(win_path=win_path_text)
    finally:
        try:
            os.remove(tmp_file)
        except OSError:
            pass


def _read_clipboard_image_via_win32_powershell() -> ClipboardImage | None:
    tmp_file = os.path.join(tempfile.gettempdir(), f"pi-win-clip-{uuid.uuid4()}.png")
    try:
        return _read_clipboard_image_via_powershell(win_path=tmp_file)
    finally:
        try:
            os.remove(tmp_file)
        except OSError:
            pass


def _read_clipboard_image_via_xclip() -> ClipboardImage | None:
    targets = _run_command(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"])
    candidate_types: list[str] = []
    if targets is not None:
        candidate_types = [
            line.strip()
            for line in targets.decode("utf-8", errors="replace").splitlines()
            if line.strip()
        ]

    preferred = _select_preferred_image_mime_type(candidate_types) if candidate_types else None
    try_types = (
        [preferred, *SUPPORTED_IMAGE_MIME_TYPES] if preferred else list(SUPPORTED_IMAGE_MIME_TYPES)
    )
    seen: set[str] = set()
    for mime_type in try_types:
        if mime_type in seen:
            continue
        seen.add(mime_type)
        data = _run_command(["xclip", "-selection", "clipboard", "-t", mime_type, "-o"])
        if data:
            return ClipboardImage(bytes=data, mime_type=_base_mime_type(mime_type))
    return None


def _read_clipboard_image_via_pngpaste() -> ClipboardImage | None:
    data = _run_command(["pngpaste", "-"])
    if not data:
        return None
    return ClipboardImage(bytes=data, mime_type="image/png")


def read_clipboard_image(
    *,
    env: dict[str, str] | None = None,
    platform: str | None = None,
) -> ClipboardImage | None:
    values = dict(os.environ if env is None else env)
    if values.get("TERMUX_VERSION"):
        return None

    current_platform = platform or sys.platform
    image: ClipboardImage | None = None

    if current_platform == "linux":
        wsl = _is_wsl(values)
        wayland = is_wayland_session(values)
        if wayland or wsl:
            image = _read_clipboard_image_via_wl_paste() or _read_clipboard_image_via_xclip()
        if image is None and wsl:
            image = _read_clipboard_image_via_wsl_powershell()
        if image is None and not wayland:
            image = _read_clipboard_image_via_xclip()
    elif current_platform == "darwin":
        image = _read_clipboard_image_via_pngpaste()
    elif current_platform == "win32":
        image = _read_clipboard_image_via_win32_powershell()

    if image is None:
        return None

    if not _is_supported_image_mime_type(image.mime_type):
        png_bytes = _convert_to_png(image.bytes)
        if not png_bytes:
            return None
        return ClipboardImage(bytes=png_bytes, mime_type="image/png")

    return image

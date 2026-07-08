"""Image MIME type detection from file bytes."""

from __future__ import annotations

IMAGE_TYPE_SNIFF_BYTES = 4100
PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def detect_supported_image_mime_type(buffer: bytes | bytearray) -> str | None:
    data = bytes(buffer)
    if _starts_with(data, bytes([0xFF, 0xD8, 0xFF])):
        return None if len(data) > 3 and data[3] == 0xF7 else "image/jpeg"
    if _starts_with(data, PNG_SIGNATURE):
        return "image/png" if _is_png(data) and not _is_animated_png(data) else None
    if _starts_with_ascii(data, 0, "GIF"):
        return "image/gif"
    if _starts_with_ascii(data, 0, "RIFF") and _starts_with_ascii(data, 8, "WEBP"):
        return "image/webp"
    return None


async def detect_supported_image_mime_type_from_file(file_path: str) -> str | None:
    with open(file_path, "rb") as handle:
        data = handle.read(IMAGE_TYPE_SNIFF_BYTES)
    return detect_supported_image_mime_type(data)


def _is_png(buffer: bytes) -> bool:
    return (
        len(buffer) >= 16
        and _read_uint32_be(buffer, len(PNG_SIGNATURE)) == 13
        and _starts_with_ascii(buffer, 12, "IHDR")
    )


def _is_animated_png(buffer: bytes) -> bool:
    offset = len(PNG_SIGNATURE)
    while offset + 8 <= len(buffer):
        chunk_length = _read_uint32_be(buffer, offset)
        chunk_type_offset = offset + 4
        if _starts_with_ascii(buffer, chunk_type_offset, "acTL"):
            return True
        if _starts_with_ascii(buffer, chunk_type_offset, "IDAT"):
            return False
        next_offset = offset + 8 + chunk_length + 4
        if next_offset <= offset or next_offset > len(buffer):
            return False
        offset = next_offset
    return False


def _read_uint32_be(buffer: bytes, offset: int) -> int:
    return (
        (buffer[offset] << 24)
        + (buffer[offset + 1] << 16)
        + (buffer[offset + 2] << 8)
        + buffer[offset + 3]
    )


def _starts_with(buffer: bytes, prefix: bytes) -> bool:
    return len(buffer) >= len(prefix) and buffer[: len(prefix)] == prefix


def _starts_with_ascii(buffer: bytes, offset: int, text: str) -> bool:
    encoded = text.encode("ascii")
    end = offset + len(encoded)
    if len(buffer) < end:
        return False
    return buffer[offset:end] == encoded

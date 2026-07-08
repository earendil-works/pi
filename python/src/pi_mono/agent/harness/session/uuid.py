"""UUID v7 generator implementation."""

import time


last_timestamp = -1
sequence = 0


def _fill_random_bytes(bytes_arr: list[int]) -> None:
    """Fill bytes with random values."""
    try:
        import secrets

        random_bytes = secrets.token_bytes(len(bytes_arr))
        for i, b in enumerate(random_bytes):
            bytes_arr[i] = b
        return
    except Exception:
        pass

    # Fallback to random module
    import random

    for i in range(len(bytes_arr)):
        bytes_arr[i] = random.randint(0, 255)


def uuidv7() -> str:
    """Generate UUID v7 (timestamp-sorted)."""
    global last_timestamp, sequence

    random = [0] * 16
    _fill_random_bytes(random)
    timestamp = int(time.time() * 1000)  # milliseconds

    if timestamp > last_timestamp:
        sequence = (random[6] << 24) | (random[7] << 16) | (random[8] << 8) | random[9]
        last_timestamp = timestamp
    else:
        sequence = (sequence + 1) & 0xFFFFFFFF
        if sequence == 0:
            last_timestamp += 1

    bytes_arr = [0] * 16
    bytes_arr[0] = (last_timestamp // 0x10000000000) & 0xFF
    bytes_arr[1] = (last_timestamp // 0x100000000) & 0xFF
    bytes_arr[2] = (last_timestamp // 0x1000000) & 0xFF
    bytes_arr[3] = (last_timestamp // 0x10000) & 0xFF
    bytes_arr[4] = (last_timestamp // 0x100) & 0xFF
    bytes_arr[5] = last_timestamp & 0xFF
    bytes_arr[6] = 0x70 | ((sequence >> 28) & 0x0F)
    bytes_arr[7] = (sequence >> 20) & 0xFF
    bytes_arr[8] = 0x80 | ((sequence >> 14) & 0x3F)
    bytes_arr[9] = (sequence >> 6) & 0xFF
    bytes_arr[10] = ((sequence & 0x3F) << 2) | (random[10] & 0x03)
    bytes_arr[11] = random[11]
    bytes_arr[12] = random[12]
    bytes_arr[13] = random[13]
    bytes_arr[14] = random[14]
    bytes_arr[15] = random[15]

    return _format_uuid(bytes_arr)


def _format_uuid(bytes_arr: list[int]) -> str:
    hex_str = "".join(f"{b:02x}" for b in bytes_arr)
    return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:]}"

import struct


def short_hash(str_val: str) -> str:
    """Fast deterministic hash to shorten long strings.

    Behaves identically to the JavaScript version by iterating over UTF-16 code units.
    """
    h1 = 0xDEADBEEF
    h2 = 0x41C6CE57

    # Process UTF-16 code units like JavaScript charCodeAt
    # utf-16-le encodes characters into 16-bit words (little endian)
    data = str_val.encode("utf-16-le")
    code_units = list(struct.unpack(f"<{len(data)//2}H", data))

    for ch in code_units:
        h1 = ((h1 ^ ch) * 2654435761) & 0xFFFFFFFF
        h2 = ((h2 ^ ch) * 1597334677) & 0xFFFFFFFF

    term1 = ((h1 ^ (h1 >> 16)) * 2246822507) & 0xFFFFFFFF
    term2 = ((h2 ^ (h2 >> 13)) * 3266489909) & 0xFFFFFFFF
    h1 = term1 ^ term2

    term3 = ((h2 ^ (h2 >> 16)) * 2246822507) & 0xFFFFFFFF
    term4 = ((h1 ^ (h1 >> 13)) * 3266489909) & 0xFFFFFFFF
    h2 = term3 ^ term4

    def to_base36(num: int) -> str:
        if num == 0:
            return "0"
        chars = "0123456789abcdefghijklmnopqrstuvwxyz"
        result = []
        while num > 0:
            num, d = divmod(num, 36)
            result.append(chars[d])
        return "".join(reversed(result))

    return to_base36(h2) + to_base36(h1)

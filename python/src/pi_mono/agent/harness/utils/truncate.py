from typing import Optional, Literal, TypedDict

DEFAULT_MAX_LINES = 2000
DEFAULT_MAX_BYTES = 50 * 1024
GREP_MAX_LINE_LENGTH = 500


class TruncationResult(TypedDict):
    content: str
    truncated: bool
    truncatedBy: Optional[Literal["lines", "bytes"]]
    totalLines: int
    totalBytes: int
    outputLines: int
    outputBytes: int
    lastLinePartial: bool
    firstLineExceedsLimit: bool
    maxLines: int
    maxBytes: int


class TruncationOptions(TypedDict, total=False):
    maxLines: int
    maxBytes: int


def utf8ByteLength(content: str) -> int:
    return len(content.encode("utf-8", errors="surrogatepass"))


def formatSize(bytes_count: int) -> str:
    if bytes_count < 1024:
        return f"{bytes_count}B"
    elif bytes_count < 1024 * 1024:
        return f"{(bytes_count / 1024):.1f}KB"
    else:
        return f"{(bytes_count / (1024 * 1024)):.1f}MB"


def truncateHead(content: str, options: Optional[TruncationOptions] = None) -> TruncationResult:
    maxLines = options.get("maxLines", DEFAULT_MAX_LINES) if options else DEFAULT_MAX_LINES
    maxBytes = options.get("maxBytes", DEFAULT_MAX_BYTES) if options else DEFAULT_MAX_BYTES

    totalBytes = utf8ByteLength(content)
    lines = content.split("\n")
    totalLines = len(lines)

    if totalLines <= maxLines and totalBytes <= maxBytes:
        return {
            "content": content,
            "truncated": False,
            "truncatedBy": None,
            "totalLines": totalLines,
            "totalBytes": totalBytes,
            "outputLines": totalLines,
            "outputBytes": totalBytes,
            "lastLinePartial": False,
            "firstLineExceedsLimit": False,
            "maxLines": maxLines,
            "maxBytes": maxBytes,
        }

    firstLineBytes = utf8ByteLength(lines[0])
    if firstLineBytes > maxBytes:
        return {
            "content": "",
            "truncated": True,
            "truncatedBy": "bytes",
            "totalLines": totalLines,
            "totalBytes": totalBytes,
            "outputLines": 0,
            "outputBytes": 0,
            "lastLinePartial": False,
            "firstLineExceedsLimit": True,
            "maxLines": maxLines,
            "maxBytes": maxBytes,
        }

    outputLinesArr: list[str] = []
    outputBytesCount = 0
    truncatedBy: Literal["lines", "bytes"] = "lines"

    for i, line in enumerate(lines[:maxLines]):
        lineBytes = utf8ByteLength(line) + (1 if i > 0 else 0)
        if outputBytesCount + lineBytes > maxBytes:
            truncatedBy = "bytes"
            break
        outputLinesArr.append(line)
        outputBytesCount += lineBytes

    if len(outputLinesArr) >= maxLines and outputBytesCount <= maxBytes:
        truncatedBy = "lines"

    outputContent = "\n".join(outputLinesArr)
    finalOutputBytes = utf8ByteLength(outputContent)

    return {
        "content": outputContent,
        "truncated": True,
        "truncatedBy": truncatedBy,
        "totalLines": totalLines,
        "totalBytes": totalBytes,
        "outputLines": len(outputLinesArr),
        "outputBytes": finalOutputBytes,
        "lastLinePartial": False,
        "firstLineExceedsLimit": False,
        "maxLines": maxLines,
        "maxBytes": maxBytes,
    }


def truncateTail(content: str, options: Optional[TruncationOptions] = None) -> TruncationResult:
    maxLines = options.get("maxLines", DEFAULT_MAX_LINES) if options else DEFAULT_MAX_LINES
    maxBytes = options.get("maxBytes", DEFAULT_MAX_BYTES) if options else DEFAULT_MAX_BYTES

    totalBytes = utf8ByteLength(content)
    lines = content.split("\n")
    if len(lines) > 1 and lines[-1] == "":
        lines.pop()
    totalLines = len(lines)

    if totalLines <= maxLines and totalBytes <= maxBytes:
        return {
            "content": content,
            "truncated": False,
            "truncatedBy": None,
            "totalLines": totalLines,
            "totalBytes": totalBytes,
            "outputLines": totalLines,
            "outputBytes": totalBytes,
            "lastLinePartial": False,
            "firstLineExceedsLimit": False,
            "maxLines": maxLines,
            "maxBytes": maxBytes,
        }

    outputLinesArr: list[str] = []
    outputBytesCount = 0
    truncatedBy: Literal["lines", "bytes"] = "lines"
    lastLinePartial = False

    for i in range(len(lines) - 1, -1, -1):
        if len(outputLinesArr) >= maxLines:
            break
        line = lines[i]
        lineBytes = utf8ByteLength(line) + (1 if outputLinesArr else 0)

        if outputBytesCount + lineBytes > maxBytes:
            truncatedBy = "bytes"
            if not outputLinesArr:
                truncatedLine = truncateStringToBytesFromEnd(line, maxBytes)
                outputLinesArr.insert(0, truncatedLine)
                outputBytesCount = utf8ByteLength(truncatedLine)
                lastLinePartial = True
            break

        outputLinesArr.insert(0, line)
        outputBytesCount += lineBytes

    if len(outputLinesArr) >= maxLines and outputBytesCount <= maxBytes:
        truncatedBy = "lines"

    outputContent = "\n".join(outputLinesArr)
    finalOutputBytes = utf8ByteLength(outputContent)

    return {
        "content": outputContent,
        "truncated": True,
        "truncatedBy": truncatedBy,
        "totalLines": totalLines,
        "totalBytes": totalBytes,
        "outputLines": len(outputLinesArr),
        "outputBytes": finalOutputBytes,
        "lastLinePartial": lastLinePartial,
        "firstLineExceedsLimit": False,
        "maxLines": maxLines,
        "maxBytes": maxBytes,
    }


def truncateStringToBytesFromEnd(s: str, maxBytes: int) -> str:
    if maxBytes <= 0:
        return ""
    b = s.encode("utf-8", errors="surrogatepass")
    if len(b) <= maxBytes:
        return s

    sliced = b[-maxBytes:]
    idx = 0
    while idx < len(sliced) and (sliced[idx] & 0xC0) == 0x80:
        idx += 1

    final_bytes = sliced[idx:]
    return final_bytes.decode("utf-8", errors="surrogatepass")


class TruncateLineResult(TypedDict):
    text: str
    wasTruncated: bool


def truncateLine(line: str, maxChars: int = GREP_MAX_LINE_LENGTH) -> TruncateLineResult:
    if len(line) <= maxChars:
        return {"text": line, "wasTruncated": False}
    return {"text": f"{line[:maxChars]}... [truncated]", "wasTruncated": True}

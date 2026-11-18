"""Provide bounded, read-only access to complete extracted deliverable evidence."""

from __future__ import annotations

import hashlib
import json
import re

from pydantic import BaseModel, ConfigDict, Field


MAX_EVIDENCE_READS = 8
MAX_EVIDENCE_CHARS = 16000


class EvidenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    file: str
    query: str | None = Field(max_length=500)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=MAX_EVIDENCE_CHARS)


class EvidenceView:
    """Resolve only extracted submission entries; never open a model-supplied path."""

    def __init__(self, contents: dict[str, str]):
        self.contents = contents
        self.reads: list[dict] = []

    def manifest(self) -> str:
        return json.dumps([
            {"file": name, "characters": len(text), "sha256": hashlib.sha256(text.encode()).hexdigest()}
            for name, text in self.contents.items()
        ], ensure_ascii=False)

    def tool(self) -> dict:
        schema = EvidenceRequest.model_json_schema()
        schema["properties"]["file"]["enum"] = list(self.contents)
        return {"type": "function", "function": {
            "name": "read_output_evidence", "strict": True,
            "description": (
                "Read complete extracted evidence omitted or abbreviated in the initial view. "
                "query=null reads a character range; a nonempty query searches literal text, "
                "case-insensitively, from offset and returns matching contexts. Follow next_offset "
                "to continue. Excel values retain sheet headings, column letters and row numbers."
            ),
            "parameters": schema,
        }}

    def read(self, arguments: str) -> str:
        if len(self.reads) >= MAX_EVIDENCE_READS:
            raise ValueError("Complete-evidence read budget exhausted")
        request = EvidenceRequest.model_validate_json(arguments)
        if request.file not in self.contents:
            raise ValueError("Unknown extracted submission file")
        text = self.contents[request.file]
        if request.offset > len(text):
            raise ValueError("Evidence offset exceeds the file length")
        if request.query == "":
            raise ValueError("Use query=null to read a range or a nonempty literal query")
        if request.query is None:
            end = min(len(text), request.offset + request.limit)
            result = {"file": request.file, "offset": request.offset,
                      "next_offset": end if end < len(text) else None,
                      "characters": len(text), "text": text[request.offset:end]}
        else:
            matches = []
            remaining = request.limit
            next_offset = None
            # Escape the submitted query: the model cannot supply executable regexes.
            for match in re.finditer(re.escape(request.query), text[request.offset:], re.IGNORECASE):
                position = request.offset + match.start()
                start = max(0, position - min(400, remaining // 4))
                end = min(len(text), start + min(2000, remaining))
                matches.append({"offset": start, "match_offset": position, "text": text[start:end]})
                remaining -= end - start
                next_offset = request.offset + match.end()
                if remaining <= 0 or len(matches) >= 8:
                    break
            else:
                next_offset = None
            result = {"file": request.file, "query": request.query, "characters": len(text),
                      "matches": matches, "next_offset": next_offset}
        self.reads.append({"request": request.model_dump(), "result": result})
        return json.dumps(result, ensure_ascii=False)

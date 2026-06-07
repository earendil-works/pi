---
name: mineru
description: Convert PDF, Office (DOC/DOCX/PPT/PPTX), images (PNG/JPG/JPEG), and HTML into clean Markdown and structured JSON using the MinerU document-parsing API. Supports OCR (109 languages), formula and table recognition, page ranges, and extra output formats (docx/html/latex). Use when extracting, parsing, or converting documents to Markdown.
metadata:
  source: https://mineru.net
---

# MinerU Document Parsing

Converts PDF, DOC, DOCX, PPT, PPTX, PNG, JPG, JPEG, and HTML into Markdown plus structured JSON via the MinerU cloud API (`https://mineru.net/api/v4`). No local GPU required.

## Setup

Get a token (90-day validity) at https://mineru.net/apiManage/token, then store it:

```bash
mkdir -p ~/.config/mineru
echo "YOUR_TOKEN" > ~/.config/mineru/token
chmod 600 ~/.config/mineru/token
```

The helper reads `MINERU_TOKEN` or `~/.config/mineru/token`. Requires `curl` and `jq`.

## Usage

```bash
# Parse a URL; prints the result-zip download link
./scripts/mineru-parse.sh https://arxiv.org/pdf/2301.00001.pdf

# Parse a local file; download + extract the markdown into ./out
./scripts/mineru-parse.sh paper.pdf --output ./out --extract

# Options
./scripts/mineru-parse.sh doc.pdf --model vlm --ocr --pages "1-5,8" --format docx
```

Run `./scripts/mineru-parse.sh --help` for all options.

## Models

| Model | When to use |
|-------|-------------|
| `hybrid` | Default. Best general accuracy. |
| `pipeline` | CPU-friendly, fast, general documents. |
| `vlm` | Complex layouts or scanned pages. |
| `MinerU-HTML` | Preserve HTML structure (web content). |

Extra formats (`--format`, repeatable): `docx`, `html`, `latex`.

## Limits

Single file ≤200 MB / ≤600 pages; 2000 priority pages/day per account; ≤200 files per batch upload.

## Output

The result zip contains the main Markdown, `content_list.json` (structured content), an `images/` folder (extracted figures), and `layout.json` (layout analysis).

See [references/api.md](references/api.md) for the full endpoint, parameter, and error-code reference, including the direct `curl` flow.

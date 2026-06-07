# MinerU API v4 Reference

Base URL: `https://mineru.net/api/v4`. Auth header: `Authorization: Bearer <token>` (token valid 90 days; get one at https://mineru.net/apiManage/token).

## 1. Create extraction task (single URL)

`POST /extract/task`

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | yes | - | File URL (remote fetch; no direct upload) |
| `model_version` | string | no | `hybrid` | `hybrid` / `pipeline` / `vlm` / `MinerU-HTML` |
| `is_ocr` | bool | no | `false` | Force OCR |
| `enable_formula` | bool | no | `true` | Formula recognition |
| `enable_table` | bool | no | `true` | Table recognition |
| `language` | string | no | `ch` | Document language |
| `page_ranges` | string | no | - | e.g. `"2,4-6"` |
| `data_id` | string | no | - | Custom tracking id |
| `callback` | string | no | - | Webhook URL for async result |
| `extra_formats` | array | no | - | Any of `["docx","html","latex"]` |

Response: `{"code":0,"data":{"task_id":"..."},"msg":"ok"}`

## 2. Get task result

`GET /extract/task/{task_id}`

States: `pending` → `running` → `done` / `failed` / `converting`. While running, `data.extract_progress` reports `extracted_pages`/`total_pages`. On `done`, `data.full_zip_url` holds the download link. On `failed`, `data.err_msg` explains why.

## 3. Upload local files (batch)

`POST /file-urls/batch` with `{"files":[{"name":"demo.pdf", ...per-file options...}]}` returns `data.batch_id` and `data.file_urls` (presigned PUT URLs, valid 24h).

- `file_urls[i]` may be a plain string or `{ "url": ... }` — handle both.
- `PUT` the raw file bytes to the presigned URL with an empty `Content-Type` (the OSS signature excludes it).
- After upload the system auto-submits extraction; poll the batch results endpoint.

## 4. Batch URL extraction

`POST /extract/task/batch` submits multiple URLs at once and returns `data.batch_id`.

## 5. Batch results

`GET /extract-results/batch/{batch_id}` returns `data.extract_result[]`, each entry shaped like a single-task result (`state`, `full_zip_url`, `err_msg`).

## Direct curl flow (URL)

```bash
TOKEN=$(cat ~/.config/mineru/token)
curl -s -X POST https://mineru.net/api/v4/extract/task \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/doc.pdf","model_version":"hybrid"}'
# -> {"code":0,"data":{"task_id":"TID"}}
curl -s https://mineru.net/api/v4/extract/task/TID -H "Authorization: Bearer $TOKEN"
# poll until {"data":{"state":"done","full_zip_url":"..."}}
```

## Output zip contents

| Item | Description |
|------|-------------|
| `*.md` | Main Markdown output |
| `content_list.json` | Ordered structured content blocks |
| `images/` | Extracted figures/tables as images |
| `layout.json` | Page layout analysis |
| `*.docx` / `*.html` / `*.tex` | Present when requested via `extra_formats` |

## Error codes

| Code | Issue | Fix |
|------|-------|-----|
| A0202 | Token invalid | Check the `Bearer` prefix and token value |
| A0211 | Token expired | Recreate at mineru.net (90-day validity) |
| -60002 | Unrecognized format | Check the file extension |
| -60005 | File too large | Max 200 MB |
| -60006 | Too many pages | Max 600; split the document |
| -60008 | URL timeout | Ensure the URL is publicly reachable |
| -60012 | Task not found | Verify `task_id` / `batch_id` |

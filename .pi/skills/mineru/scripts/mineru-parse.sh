#!/usr/bin/env bash
# MinerU document parser: submit a URL or local file, poll, optionally download + extract.
# Token: $MINERU_TOKEN or ~/.config/mineru/token  (get one at https://mineru.net/apiManage/token)
set -euo pipefail

TOKEN_FILE="${MINERU_TOKEN_FILE:-$HOME/.config/mineru/token}"
BASE="${MINERU_API_BASE:-https://mineru.net/api/v4}"
POLL="${MINERU_POLL_INTERVAL:-5}"
MAX="${MINERU_MAX_POLL:-360}"

MODEL=hybrid; OCR=false; FORMULA=true; TABLE=true
OUTPUT=""; PAGES=""; EXTRACT=false; FORMATS=(); INPUT=""

usage() {
  cat <<'EOF'
MinerU Document Parser
Usage: mineru-parse.sh <url|file> [options]

  --model <m>     hybrid (default) | pipeline | vlm | MinerU-HTML
  --ocr           force OCR
  --no-formula    disable formula recognition
  --no-table      disable table recognition
  --pages <r>     page ranges, e.g. "1-5,8"
  --format <f>    extra output format docx|html|latex (repeatable)
  --output <dir>  download the result zip into <dir>
  --extract       unzip the result and print the markdown (use with --output)
  -h, --help      show this help

Env: MINERU_TOKEN / MINERU_TOKEN_FILE / MINERU_API_BASE / MINERU_POLL_INTERVAL / MINERU_MAX_POLL
Supported inputs: PDF, DOC, DOCX, PPT, PPTX, PNG, JPG, JPEG, HTML
EOF
  exit 0
}

for c in curl jq; do command -v "$c" >/dev/null 2>&1 || { echo "error: '$c' is required" >&2; exit 1; }; done

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    --model) MODEL="$2"; shift 2 ;;
    --ocr) OCR=true; shift ;;
    --no-formula) FORMULA=false; shift ;;
    --no-table) TABLE=false; shift ;;
    --pages) PAGES="$2"; shift 2 ;;
    --format) FORMATS+=("$2"); shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --extract) EXTRACT=true; shift ;;
    -*) echo "error: unknown option $1" >&2; exit 1 ;;
    *) INPUT="$1"; shift ;;
  esac
done
[ -n "$INPUT" ] || { echo "error: no input given (use -h)" >&2; exit 1; }

TOKEN="${MINERU_TOKEN:-}"
[ -n "$TOKEN" ] || TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
[ -n "$TOKEN" ] || { echo "error: no token. Set MINERU_TOKEN or write $TOKEN_FILE (https://mineru.net/apiManage/token)" >&2; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

# Common option object shared by URL and upload bodies.
opts_json() {
  jq -n --arg m "$MODEL" --argjson o "$OCR" --argjson f "$FORMULA" --argjson t "$TABLE" --arg p "$PAGES" \
    '{model_version:$m, is_ocr:$o, enable_formula:$f, enable_table:$t}
     + (if $p != "" then {page_ranges:$p} else {} end)'
}

add_formats() {  # merge extra_formats array into the json object on stdin
  if [ ${#FORMATS[@]} -gt 0 ]; then
    local arr; arr="$(printf '%s\n' "${FORMATS[@]}" | jq -R . | jq -s .)"
    jq --argjson a "$arr" '. + {extra_formats:$a}'
  else
    cat
  fi
}

download() {  # $1 = zip url
  if [ -z "$OUTPUT" ]; then echo "$1"; return; fi
  mkdir -p "$OUTPUT"
  local zip="$OUTPUT/mineru_result.zip"
  curl -fsSL -o "$zip" "$1"
  echo "saved: $zip"
  if $EXTRACT; then
    unzip -qo "$zip" -d "$OUTPUT"
    local md; md="$(find "$OUTPUT" -name '*.md' -type f | head -1)"
    [ -n "$md" ] && { echo "--- $md ---"; cat "$md"; }
  fi
}

poll() {  # $1 = task|batch, $2 = id
  local url filt i=0 d
  if [ "$1" = task ]; then url="$BASE/extract/task/$2"; filt='.data'
  else url="$BASE/extract-results/batch/$2"; filt='.data.extract_result[0]'; fi
  while [ "$i" -lt "$MAX" ]; do
    i=$((i+1))
    d="$(curl -fsS "$url" -H "$AUTH" | jq "$filt")"
    case "$(echo "$d" | jq -r '.state')" in
      done) download "$(echo "$d" | jq -r '.full_zip_url')"; return ;;
      failed) echo "error: extraction failed: $(echo "$d" | jq -r '.err_msg // empty')" >&2; exit 1 ;;
      *) echo "[$(echo "$d" | jq -r '.state')] $i/$MAX" >&2 ;;
    esac
    sleep "$POLL"
  done
  echo "error: timed out after $((MAX*POLL))s" >&2; exit 1
}

if [[ "$INPUT" =~ ^https?:// ]]; then
  body="$(opts_json | jq --arg u "$INPUT" '. + {url:$u}' | add_formats)"
  tid="$(curl -fsS -X POST "$BASE/extract/task" -H "$AUTH" -H 'Content-Type: application/json' -d "$body" | jq -r '.data.task_id')"
  echo "task_id=$tid" >&2
  poll task "$tid"
else
  [ -f "$INPUT" ] || { echo "error: file not found: $INPUT" >&2; exit 1; }
  fbody="$(opts_json | jq --arg n "$(basename "$INPUT")" '{files:[. + {name:$n}]}')"
  if [ ${#FORMATS[@]} -gt 0 ]; then
    arr="$(printf '%s\n' "${FORMATS[@]}" | jq -R . | jq -s .)"
    fbody="$(echo "$fbody" | jq --argjson a "$arr" '.files[0] += {extra_formats:$a}')"
  fi
  resp="$(curl -fsS -X POST "$BASE/file-urls/batch" -H "$AUTH" -H 'Content-Type: application/json' -d "$fbody")"
  up="$(echo "$resp" | jq -r 'if (.data.file_urls[0]|type)=="string" then .data.file_urls[0] else .data.file_urls[0].url end')"
  bid="$(echo "$resp" | jq -r '.data.batch_id')"
  curl -fsS -X PUT "$up" -H 'Content-Type:' -T "$INPUT"
  echo "batch_id=$bid" >&2
  poll batch "$bid"
fi

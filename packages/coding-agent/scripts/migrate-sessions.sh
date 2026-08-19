#!/usr/bin/env bash
#
# Migrate sessions from ~/.spi/agent/*.jsonl to proper session directories.
# This fixes sessions created by the bug in v0.30.0 where sessions were
# saved to ~/.spi/agent/ instead of ~/.spi/agent/sessions/<encoded-cwd>/.
#
# Usage: ./migrate-sessions.sh [--dry-run]
#

set -e

AGENT_DIR="${SPI_AGENT_DIR:-$HOME/.pi/agent}"
DRY_RUN=false

if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "Dry run mode - no files will be moved"
    echo
fi

# Find all .jsonl files directly in agent dir (not in subdirectories)
shopt -s nullglob
files=("$AGENT_DIR"/*.jsonl)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
    echo "No session files found in $AGENT_DIR"
    exit 0
fi

echo "Found ${#files[@]} session file(s) to migrate"
echo

migrated=0
failed=0

for file in "${files[@]}"; do
    filename=$(basename "$file")
    
    # Read first line and extract cwd using jq
    if ! first_line=$(head -1 "$file" 2>/dev/null); then
        echo "SKIP: $filename - cannot read file"
        ((failed++))
        continue
    fi
    
    # Parse JSON and extract cwd
    if ! cwd=$(echo "$first_line" | jq -r '.cwd // empty' 2>/dev/null); then
        echo "SKIP: $filename - invalid JSON"
        ((failed++))
        continue
    fi
    
    if [[ -z "$cwd" ]]; then
        echo "SKIP: $filename - no cwd in session header"
        ((failed++))
        continue
    fi
    
    # Encode cwd: remove leading slash, replace slashes with dashes, wrap with --
    encoded=$(echo "$cwd" | sed 's|^/||' | sed 's|[/:\\]|-|g')
    encoded="--${encoded}--"
    
    target_dir="$AGENT_DIR/sessions/$encoded"
    target_file="$target_dir/$filename"
    
    if [[ -e "$target_file" ]]; then
        echo "SKIP: $filename - target already exists"
        ((failed++))
        continue
    fi
    
    echo "MIGRATE: $filename"
    echo "    cwd: $cwd"
    echo "    to:  $target_dir/"
    
    if [[ "$DRY_RUN" == false ]]; then
        mkdir -p "$target_dir"
        mv "$file" "$target_file"
    fi
    
    ((migrated++))
    echo
done

echo "---"
echo "Migrated: $migrated"
echo "Skipped:  $failed"

if [[ "$DRY_RUN" == true && $migrated -gt 0 ]]; then
    echo
    echo "Run without --dry-run to perform the migration"
fi

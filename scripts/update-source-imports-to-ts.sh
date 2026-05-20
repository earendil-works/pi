#!/usr/bin/env bash
set -euo pipefail

# Rewrites relative source import specifiers in package source directories from .js to .ts.
# TypeScript's rewriteRelativeImportExtensions option rewrites these back to .js in emitted output.
find packages -mindepth 2 -maxdepth 2 -type d -name src -print0 |
	while IFS= read -r -d '' src_dir; do
		find "$src_dir" -type f -name '*.ts' -print0
	done |
	xargs -0 perl -0pi -e 's/(\b(?:from|import)\b\s*\(?\s*["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27]\s*\)?)/$1$2.ts$3/g; s/(\bdeclare\s+module\s+["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27])/$1$2.ts$3/g; s/(\bimportNodeOnlyProvider\(\s*["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27]\s*\))/$1$2.ts$3/g'

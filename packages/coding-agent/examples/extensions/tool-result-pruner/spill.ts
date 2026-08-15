/**
 * Tool-output spill: persist oversized text to a file and replace it inline
 * with a bounded preview + retrieval locator. Modeled on dsh's spill family
 * (spill-local + spill-policy, maxInlineBytes 50000).
 *
 * Filesystem access is injectable for testability.
 */
import { codePointLength } from "./prune.ts";

export interface SpillDeps {
  fs: {
    mkdirSync(path: string): void;
    writeFileSync(path: string, content: string): void;
    readdirSync(path: string): string[];
    statSync(path: string): { mtimeMs: number };
    unlinkSync(path: string): void;
  };
  now(): number;
}

export interface SpillOptions {
  /** Unique id for this result (e.g. toolCallId); sanitized into the filename. */
  id: string;
  spillDir: string;
  thresholdChars: number;
  previewHeadChars: number;
  previewTailChars: number;
  retentionDays: number;
}

/** Reduce an arbitrary id to a filename-safe token. */
function safeName(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unnamed";
}

function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

function tail(text: string, n: number): string {
  const pts = Array.from(text);
  return pts.slice(Math.max(0, pts.length - n)).join("");
}

/** Best-effort deletion of expired spill files; never throws into the caller. */
function enforceRetention(dir: string, retentionDays: number, deps: SpillDeps): void {
  try {
    const cutoff = deps.now() - retentionDays * 24 * 3600 * 1000;
    for (const name of deps.fs.readdirSync(dir)) {
      const path = `${dir}/${name}`;
      try {
        if (deps.fs.statSync(path).mtimeMs < cutoff) {
          deps.fs.unlinkSync(path);
        }
      } catch {
        // individual file failures don't block the spill
      }
    }
  } catch {
    // directory unreadable — retention skipped
  }
}

export interface WriteSpillFileOptions {
  id: string;
  spillDir: string;
  retentionDays: number;
}

/**
 * Write full text to `<spillDir>/<safe-id>.txt`, run retention, return the path.
 * Shared by both the spill tier (>50K) and the prune tier's spill-copy.
 */
export function writeSpillFile(text: string, opts: WriteSpillFileOptions, deps: SpillDeps): string {
  deps.fs.mkdirSync(opts.spillDir);
  const path = `${opts.spillDir}/${safeName(opts.id)}.txt`;
  deps.fs.writeFileSync(path, text);
  enforceRetention(opts.spillDir, opts.retentionDays, deps);
  return path;
}

/**
 * Return `text` unchanged when at or under the threshold. Otherwise write the
 * full content to `<spillDir>/<safe-id>.txt` and return a head+tail preview
 * whose marker carries the file path and original size.
 */
export function spillText(text: string, opts: SpillOptions, deps: SpillDeps): string {
  const length = codePointLength(text);
  if (length <= opts.thresholdChars) {
    return text;
  }

  const path = writeSpillFile(text, { id: opts.id, spillDir: opts.spillDir, retentionDays: opts.retentionDays }, deps);

  const marker =
    `\n\n[... output spilled: ${length} code points total; full output saved to ${path}; grep that file if you need it ...]\n\n`;
  return head(text, opts.previewHeadChars) + marker + tail(text, opts.previewTailChars);
}

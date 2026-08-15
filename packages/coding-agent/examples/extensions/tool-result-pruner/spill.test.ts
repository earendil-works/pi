import { test } from "node:test";
import assert from "node:assert/strict";
import { spillText } from "./spill.ts";

/** Minimal in-memory fs fake — test-only. */
function makeFakeFs(now: number) {
  const files = new Map<string, { content: string; mtime: number }>();
  const dirs = new Set<string>();
  const fs = {
    mkdirSync: (p: string) => { dirs.add(p); },
    writeFileSync: (p: string, content: string) => { files.set(p, { content, mtime: now }); },
    readdirSync: (p: string) => [...files.keys()].filter((f) => f.startsWith(p + "/")).map((f) => f.slice(p.length + 1)),
    statSync: (p: string) => ({ mtimeMs: files.get(p)?.mtime ?? 0 }),
    unlinkSync: (p: string) => { files.delete(p); },
    __files: files,
  };
  return fs;
}

const baseOpts = {
  id: "call-123",
  spillDir: "/tmp/spill-test",
  thresholdChars: 100,
  previewHeadChars: 20,
  previewTailChars: 10,
  retentionDays: 7,
};

test("under-threshold content is returned unchanged and nothing is written", () => {
  const fs = makeFakeFs(Date.now());
  const result = spillText("short", baseOpts, { fs, now: () => Date.now() });
  assert.equal(result, "short");
  assert.equal(fs.__files.size, 0);
});

test("over-threshold content is written to disk and replaced by a preview with locator", () => {
  const t = Date.now();
  const fs = makeFakeFs(t);
  const text = "H".repeat(60) + "MIDDLE" + "T".repeat(50); // 117 chars > 100
  const result = spillText(text, baseOpts, { fs, now: () => t });

  // exactly one file written, containing the FULL content
  assert.equal(fs.__files.size, 1);
  const [path] = [...fs.__files.keys()];
  assert.ok(path.startsWith("/tmp/spill-test/"));
  assert.equal(fs.__files.get(path)!.content, text);

  // preview keeps head and tail, replaces middle with locator pointing at the file
  assert.ok(result.startsWith("H".repeat(20)));
  assert.ok(result.endsWith("T".repeat(10)));
  assert.ok(result.includes(path), "preview must contain the spill file path");
  assert.ok(result.includes("116"), "preview must report original size");
  assert.ok(!result.includes("MIDDLE"));
});

test("spill marker says grep not read (prevents recovery loop)", () => {
  const t = Date.now();
  const fs = makeFakeFs(t);
  const text = "H".repeat(60) + "MIDDLE" + "T".repeat(50);
  const result = spillText(text, baseOpts, { fs, now: () => t });
  assert.ok(result.includes("grep"), "marker must say grep");
  assert.ok(!result.includes("read that file"), "marker must not say read");
});

test("ids with path-hostile characters are sanitized into safe filenames", () => {
  const t = Date.now();
  const fs = makeFakeFs(t);
  const text = "x".repeat(150);
  spillText(text, { ...baseOpts, id: "evil/../../etc/passwd" }, { fs, now: () => t });
  const [path] = [...fs.__files.keys()];
  assert.ok(!path.includes(".."), `path traversal in ${path}`);
  assert.equal(path.split("/").length, 4); // /tmp/spill-test/<one-safe-name>
});

test("spill deletes retention-expired files in the same directory", () => {
  const t = Date.now();
  const fs = makeFakeFs(t);
  // stale file from 30 days ago
  fs.writeFileSync("/tmp/spill-test/old.txt", "stale");
  fs.__files.get("/tmp/spill-test/old.txt")!.mtime = t - 30 * 24 * 3600 * 1000;

  spillText("y".repeat(150), baseOpts, { fs, now: () => t });
  assert.ok(!fs.__files.has("/tmp/spill-test/old.txt"), "stale file must be deleted");
  assert.equal(fs.__files.size, 1, "only the fresh spill remains");
});

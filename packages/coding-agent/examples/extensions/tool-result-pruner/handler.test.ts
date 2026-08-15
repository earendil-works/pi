import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createToolResultHandler, createRuntimeDeps, createStats } from "./index.ts";
import { resolveConfig } from "./config.ts";
import { makeFakeFs } from "./test-utils.ts";

function textEvent(text: string, toolName = "bash", toolCallId = "tc_1") {
  return {
    type: "tool_result" as const,
    toolName,
    toolCallId,
    input: {},
    content: [{ type: "text" as const, text }],
    isError: false,
  };
}

const config = resolveConfig({ spillDir: "/tmp/spill-test" });

test("small result passes through untouched (undefined return)", () => {
  const handler = createToolResultHandler(config, { fs: makeFakeFs(0).fs, now: () => 0 });
  const event = textEvent("tiny output");
  assert.equal(handler(event as any), undefined);
});

test("medium result (>8K) is pruned with zero-loss spill copy when pruneSpillCopy is true", () => {
  const fs = makeFakeFs(0);
  const handler = createToolResultHandler(config, { fs: fs.fs, now: () => 0 });
  const event = textEvent("m".repeat(20000));
  const result = handler(event as any) as { content: { type: string; text: string }[] };
  assert.ok(result, "must return modified content");
  assert.ok(result.content[0].text.includes("middle pruned"));
  // v2: prune tier now writes a spill file and the marker carries its path
  assert.ok(result.content[0].text.includes("/tmp/spill-test/"), "pruned result must include spill path");
  assert.equal(fs.__files.size, 1, "spill file written for prune-tier zero-loss");
  const [path] = [...fs.__files.keys()];
  assert.equal(fs.__files.get(path)!.content, "m".repeat(20000), "file holds full output");
});

test("medium result with pruneSpillCopy=false is pruned WITHOUT a spill file (v1 behavior)", () => {
  const fs = makeFakeFs(0);
  const cfg = resolveConfig({ spillDir: "/tmp/spill-test", pruneSpillCopy: false });
  const handler = createToolResultHandler(cfg, { fs: fs.fs, now: () => 0 });
  const event = textEvent("m".repeat(20000));
  const result = handler(event as any) as { content: { type: string; text: string }[] };
  assert.ok(result.content[0].text.includes("middle pruned"));
  assert.ok(!result.content[0].text.includes("/tmp/spill-test/"), "no spill path when pruneSpillCopy is false");
  assert.equal(fs.__files.size, 0, "no spill file written");
});

test("huge result (>50K) is spilled with a file locator", () => {
  const fs = makeFakeFs(0);
  const handler = createToolResultHandler(config, { fs: fs.fs, now: () => 0 });
  const event = textEvent("z".repeat(60000));
  const result = handler(event as any) as { content: { type: string; text: string }[] };
  assert.ok(result.content[0].text.includes("/tmp/spill-test/"));
  assert.equal(fs.__files.size, 1, "spill file written");
  const [path] = [...fs.__files.keys()];
  assert.equal(fs.__files.get(path)!.content, "z".repeat(60000), "file holds full output");
});

test("excluded tools pass through untouched", () => {
  const cfg = resolveConfig({ spillDir: "/tmp/spill-test", excludeTools: ["memory_search"] });
  const handler = createToolResultHandler(cfg, { fs: makeFakeFs(0).fs, now: () => 0 });
  const event = textEvent("x".repeat(60000), "memory_search");
  assert.equal(handler(event as any), undefined);
});

test("image blocks and mixed content are never mangled", () => {
  const handler = createToolResultHandler(config, { fs: makeFakeFs(0).fs, now: () => 0 });
  const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const event = {
    ...textEvent("p".repeat(20000)),
    content: [imageBlock, { type: "text", text: "p".repeat(20000) }],
  };
  const result = handler(event as any) as { content: unknown[] };
  assert.deepEqual(result.content[0], imageBlock, "image block untouched");
  assert.ok((result.content[1] as any).text.includes("middle pruned"), "text block pruned");
});

test("real-fs integration: repeated spills to the same directory all succeed", () => {
  const dir = mkdtempSync(`${tmpdir()}/pi-pruner-it-`);
  try {
    const cfg = resolveConfig({ spillDir: dir });
    const handler = createToolResultHandler(cfg, createRuntimeDeps());
    // deps are the REAL production wiring — this test pins that repeated
    // spills to an existing directory all succeed (mkdir must be recursive)
    handler(textEvent("a".repeat(60000), "bash", "tc_a") as any);
    handler(textEvent("b".repeat(60000), "bash", "tc_b") as any);
    assert.equal(readdirSync(dir).length, 2, "both spill files exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handler increments stats counters when pruning and spilling", () => {
  const stats = createStats();
  const fs = makeFakeFs(0);
  const handler = createToolResultHandler(config, { fs: fs.fs, now: () => 0 }, stats);

  // prune-tier result
  handler(textEvent("m".repeat(20000)) as any);
  assert.equal(stats.pruned, 1);
  assert.ok(stats.pruneBytesSaved > 0, "prune bytes saved must be positive");

  // spill-tier result
  handler(textEvent("z".repeat(60000)) as any);
  assert.equal(stats.spilled, 1);
  assert.ok(stats.spillBytesSaved > 0, "spill bytes saved must be positive");

  // under-threshold: no increment
  handler(textEvent("tiny") as any);
  assert.equal(stats.pruned, 1);
  assert.equal(stats.spilled, 1);
});

test("read of a spill file passes through untouched (prevents recovery loop)", () => {
  const fs = makeFakeFs(0);
  const handler = createToolResultHandler(config, { fs: fs.fs, now: () => 0 });
  const event = {
    ...textEvent("x".repeat(20000), "read", "tc_read_1"),
    input: { path: "/tmp/spill-test/some-file.txt" },
  };
  assert.equal(handler(event as any), undefined, "read of spill file must not be pruned");
});

test("handler fails open (returns undefined) on unexpected errors, never throws", () => {
  const handler = createToolResultHandler(config, { fs: makeFakeFs(0).fs, now: () => 0 });
  // malformed event: content is null (shouldn't happen but must not crash)
  const malformed = { type: "tool_result", toolName: "bash", toolCallId: "x", input: {}, content: null, isError: false };
  assert.doesNotThrow(() => handler(malformed as any));
  assert.equal(handler(malformed as any), undefined);
});

test("spill disk failure falls back to pruning (never throws, still bounded)", () => {
  const fs = makeFakeFs(0);
  fs.fs.writeFileSync = () => { throw new Error("ENOSPC"); };
  const handler = createToolResultHandler(config, { fs: fs.fs, now: () => 0 });
  const event = textEvent("q".repeat(60000));
  const result = handler(event as any) as { content: { type: string; text: string }[] };
  assert.ok(result.content[0].text.includes("middle pruned"), "pruned as fallback");
  assert.ok(result.content[0].text.length < 6000, "still bounded");
});

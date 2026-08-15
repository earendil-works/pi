import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, DEFAULT_CONFIG } from "./config.ts";

test("empty config resolves to dsh-calibrated defaults", () => {
  const resolved = resolveConfig({});
  assert.deepEqual(resolved, {
    pruneThresholdChars: 8192,
    pruneHeadChars: 4096,
    pruneTailChars: 1024,
    spillThresholdChars: 50000,
    spillPreviewHeadChars: 4096,
    spillPreviewTailChars: 1024,
    spillDir: "~/.pi/agent/cache/tool-spill",
    retentionDays: 7,
    excludeTools: [],
    enabled: true,
    pruneSpillCopy: true,
  });
});

test("explicit values override defaults", () => {
  const resolved = resolveConfig({ pruneThresholdChars: 10000, excludeTools: ["memory_search"] });
  assert.equal(resolved.pruneThresholdChars, 10000);
  assert.deepEqual(resolved.excludeTools, ["memory_search"]);
  assert.equal(resolved.spillThresholdChars, DEFAULT_CONFIG.spillThresholdChars);
});

test("unknown keys are rejected (catches misspellings)", () => {
  assert.throws(() => resolveConfig({ pruneTresholdChars: 100 }), /unknown key/i);
});

test("pruneSpillCopy defaults to true and accepts boolean override", () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.pruneSpillCopy, true);
  const off = resolveConfig({ pruneSpillCopy: false });
  assert.equal(off.pruneSpillCopy, false);
});

test("pruneSpillCopy rejects non-boolean values", () => {
  assert.throws(() => resolveConfig({ pruneSpillCopy: "yes" }), /pruneSpillCopy/);
});

test("nonsensical values are rejected", () => {
  // head + tail must fit within threshold
  assert.throws(() => resolveConfig({ pruneHeadChars: 8000, pruneTailChars: 8000 }), /must be at most/);
  // spill threshold below prune threshold makes spill unreachable
  assert.throws(() => resolveConfig({ spillThresholdChars: 4000 }), /spillThresholdChars/);
  assert.throws(() => resolveConfig({ retentionDays: -1 }), /retentionDays/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneText } from "./prune.ts";

test("content under threshold is returned unchanged", () => {
  const text = "a".repeat(100);
  const result = pruneText(text, {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  });
  assert.equal(result, text);
});

test("content exactly at threshold is returned unchanged", () => {
  const text = "x".repeat(8192);
  const result = pruneText(text, {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  });
  assert.equal(result, text);
});

test("pruning never splits surrogate pairs (astral-plane chars)", () => {
  const emoji = "🎉"; // U+1F389
  const text = emoji.repeat(10);
  const result = pruneText(text, {
    thresholdChars: 8,
    headChars: 4,
    tailChars: 2,
  });
  assert.ok(result.includes(emoji.repeat(4)), "head emoji must survive");
  assert.ok(result.endsWith(emoji.repeat(2)), "tail emoji must be last");
  for (const ch of result) {
    const code = ch.codePointAt(0)!;
    assert.ok(
      code < 0xd800 || code > 0xdfff,
      `lone surrogate in result: U+${code.toString(16)}`,
    );
  }
});

test("barely-over content with short middle still keeps full head and tail", () => {
  const text = "H".repeat(5) + "M".repeat(3) + "T".repeat(2); // 10 chars, threshold 8
  const result = pruneText(text, {
    thresholdChars: 8,
    headChars: 5,
    tailChars: 2,
  });
  assert.ok(result.includes("H".repeat(5)), "head must survive");
  assert.ok(result.endsWith("T".repeat(2)), "tail must be last");
  assert.ok(result.includes("3 code points omitted"));
  assert.ok(!result.includes("M"));
});

test("pruned result starts with a short prefix marker (survives compaction truncation)", () => {
  const text = "a".repeat(9000) + "TAILMARKER" + "b".repeat(500);
  const result = pruneText(
    text,
    { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    { spillPath: "/tmp/spill/bash-call123.txt" },
  );
  // prefix marker must be at position 0 so compaction's 2000-char serialization keeps it
  assert.ok(result.startsWith("[pruned"), "result must start with prefix marker");
  assert.ok(result.includes("/tmp/spill/bash-call123.txt"), "prefix must contain spill path");
  // the head content follows the prefix
  assert.ok(result.includes("a".repeat(100)), "head content must be present after prefix");
});

test("prefix marker without spill path includes threshold hint for narrow re-runs", () => {
  const text = "a".repeat(9000);
  const result = pruneText(text, {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  });
  assert.ok(result.startsWith("[pruned"), "prefix present");
  assert.ok(result.includes("8192"), "prefix or marker must include the threshold");
  assert.ok(!result.includes("full output at"), "no path without recovery");
});

test("pruned marker includes spill path and exact elided span when recovery path is provided", () => {
  const text = "a".repeat(9000) + "TAILMARKER" + "b".repeat(500); // 9510 code points
  const result = pruneText(
    text,
    { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    { spillPath: "/tmp/spill/bash-call123.txt" },
  );
  assert.ok(result.includes("/tmp/spill/bash-call123.txt"), "marker must contain the spill path");
  assert.ok(result.includes("[4096, 8486)"), "marker must include exact elided span");
  assert.ok(result.includes("4390 code points omitted"), "marker must report omitted count");
});

test("pruned marker includes offsets but no path when no recovery path is provided", () => {
  const text = "a".repeat(9000) + "TAILMARKER" + "b".repeat(500);
  const result = pruneText(
    text,
    { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
  );
  assert.ok(result.includes("[4096, 8486)"), "marker must still include elided span");
  assert.ok(!result.includes("full output at"), "no path reference without recovery");
});

test("content over threshold is pruned to prefix + head + marker + tail", () => {
  const text = "a".repeat(9000) + "TAILMARKER" + "b".repeat(500);
  const result = pruneText(text, {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  });
  assert.ok(result.startsWith("[pruned"), "prefix marker first");
  assert.ok(result.includes("a".repeat(4096)), "head content present");
  assert.ok(result.endsWith("TAILMARKER" + "b".repeat(500)), "tail is last");
  assert.ok(result.includes("pruned"));
  assert.ok(result.length < 5700, "total must be well under original 9500");
  assert.ok(!result.includes("a".repeat(4100)), "omitted middle is gone");
});
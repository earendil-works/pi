import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROMPT_LENGTH,
  assistantMessage,
  interpretGate,
  levelTone,
  resultLabel,
  validatePrompt,
} from "../public/lib/decision.js";

test("an allowed 200 is the only way to get an allowed view", () => {
  const view = interpretGate({
    status: 200,
    body: { allowed: true, crisisLevel: "stable", componentsInvolved: ["rrt_advocate"], executionEnabled: false },
  });
  assert.equal(view.kind, "allowed");
  assert.equal(view.failClosed, false);
  assert.deepEqual(view.components, ["rrt_advocate"]);
});

test("a blocked 200 is blocked and keeps the level and reason", () => {
  const view = interpretGate({
    status: 200,
    body: { allowed: false, crisisLevel: "emergency", blockedReason: "flagged", componentsInvolved: [] },
  });
  assert.equal(view.kind, "blocked");
  assert.equal(view.crisisLevel, "emergency");
  assert.equal(view.reason, "flagged");
});

test("anything that is not a literal allowed:true fails closed", () => {
  for (const allowed of [undefined, null, "true", 1, "yes", {}]) {
    const view = interpretGate({ status: 200, body: { allowed } });
    assert.notEqual(view.kind, "allowed", `allowed=${JSON.stringify(allowed)}`);
    assert.equal(view.failClosed, true);
  }
});

test("a malformed or missing body fails closed", () => {
  for (const body of [undefined, null, "ok", 42, []]) {
    assert.notEqual(interpretGate({ status: 200, body }).kind, "allowed");
  }
});

test("a 503 is never a pass, even if the body says allowed", () => {
  const view = interpretGate({ status: 503, body: { allowed: true } });
  assert.equal(view.kind, "unavailable");
  assert.equal(view.failClosed, true);
});

test("network errors and missing status fail closed", () => {
  assert.equal(interpretGate({ networkError: true }).kind, "unavailable");
  assert.equal(interpretGate({}).kind, "unavailable");
  assert.equal(interpretGate(undefined).kind, "unavailable");
});

test("404 means not deployed here and 400 means rejected input, neither is allowed", () => {
  assert.equal(interpretGate({ status: 404, body: { allowed: true } }).kind, "not-deployed");
  assert.equal(interpretGate({ status: 400 }).kind, "invalid");
});

test("non-string component entries are dropped", () => {
  const view = interpretGate({ status: 200, body: { allowed: true, componentsInvolved: ["a", 2, null, "b"] } });
  assert.deepEqual(view.components, ["a", "b"]);
});

test("every view kind has a message and a label, and only allowed mentions that nothing was run", () => {
  const kinds = ["allowed", "blocked", "unavailable", "not-deployed", "invalid"];
  for (const kind of kinds) {
    const view = { kind, components: [], failClosed: kind !== "allowed" && kind !== "blocked" };
    assert.ok(assistantMessage(view).length > 0);
    assert.ok(resultLabel(view).length > 0);
    // A failure or blocked view must never reuse the "passed" wording.
    if (kind !== "allowed") assert.doesNotMatch(assistantMessage(view), /passed the governance check|nothing was run/i);
  }
  assert.match(assistantMessage({ kind: "allowed", components: [] }), /Nothing was run/);
  assert.match(assistantMessage({ kind: "blocked", components: [] }), /not a judgement about you/);
  assert.match(assistantMessage({ kind: "blocked", components: [] }), /988/);
});

test("level tones", () => {
  assert.equal(levelTone("stable"), "ok");
  assert.equal(levelTone("Elevated"), "warn");
  assert.equal(levelTone("emergency"), "alert");
  assert.equal(levelTone("something-new"), "neutral");
  assert.equal(levelTone(undefined), "neutral");
  // Inherited object property names must not leak through as a tone.
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(levelTone(name), "neutral", name);
  }
});

test("prompt validation matches the endpoint limits", () => {
  assert.deepEqual(validatePrompt("  hi  "), { ok: true, prompt: "hi" });
  assert.equal(validatePrompt("   ").ok, false);
  assert.equal(validatePrompt(undefined).ok, false);
  assert.equal(validatePrompt("x".repeat(MAX_PROMPT_LENGTH)).ok, true);
  assert.deepEqual(validatePrompt("x".repeat(MAX_PROMPT_LENGTH + 1)), { ok: false, reason: "too-long" });
});

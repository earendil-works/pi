import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROMPT_LENGTH,
  agentDoneMessage,
  assistantMessage,
  interpretGate,
  interpretModels,
  modelToSend,
  interpretSession,
  levelTone,
  parseNdjson,
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

test("parseNdjson returns complete events, keeps the remainder, and drops junk", () => {
  const parsed = parseNdjson('{"type":"text","delta":"a"}\nnot json\n[1]\n{"x":1}\n{"type":"done","sta');
  assert.deepEqual(parsed.events, [{ type: "text", delta: "a" }]);
  assert.equal(parsed.rest, '{"type":"done","sta');
});

test("parseNdjson buffers a partial done event behind a complete tool event, then emits it", () => {
  const first = parseNdjson('{"type":"tool","name":"bash"}\n{"type":"done","status":"completed');
  assert.deepEqual(first.events, [{ type: "tool", name: "bash" }]);
  assert.equal(first.rest, '{"type":"done","status":"completed');
  const second = parseNdjson(`${first.rest}"}\n`);
  assert.deepEqual(second.events, [{ type: "done", status: "completed" }]);
  assert.equal(second.rest, "");
});

test("only an explicit completed status is a success", () => {
  assert.equal(agentDoneMessage({ status: "needs_access", access: [] }), undefined);
  assert.equal(agentDoneMessage({ status: "completed" }), undefined);
  for (const event of [undefined, {}, { status: "weird" }, { status: "blocked" }, { status: "error" }]) {
    assert.equal(typeof agentDoneMessage(event), "string");
  }
});

test("a failed turn shows the server's reason, shortened, and falls back to the generic note", () => {
  assert.equal(agentDoneMessage({ status: "error", reason: "Gateway returned 401" }), "The agent could not finish this turn: Gateway returned 401");
  assert.equal(agentDoneMessage({ status: "aborted", reason: "  cancelled  " }), "The agent could not finish this turn: cancelled");
  for (const reason of [undefined, "", "   ", 42, null]) {
    assert.equal(agentDoneMessage({ status: "error", reason }), "The agent could not finish this turn.");
  }
  const long = agentDoneMessage({ status: "error", reason: "x".repeat(1000) });
  assert.equal(long, `The agent could not finish this turn: ${"x".repeat(300)}`);
  // Statuses with their own message keep it.
  assert.equal(agentDoneMessage({ status: "timed_out", reason: "ignored" }), "The turn ran out of time.");
});

test("only an explicit signedIn true with a name shows as signed in", () => {
  assert.equal(interpretSession({ status: 200, body: { configured: true, signedIn: true, name: "Josh" } }).state, "signed-in");
  assert.equal(interpretSession({ status: 200, body: { configured: true, signedIn: true } }).state, "signed-out");
  assert.equal(interpretSession({ status: 200, body: { configured: true, signedIn: "yes", name: "x" } }).state, "signed-out");
  assert.equal(interpretSession({ status: 200, body: { configured: false, signedIn: false } }).state, "not-configured");
  for (const result of [undefined, { networkError: true }, { status: 500, body: { signedIn: true, name: "x" } }, { status: 200, body: null }]) {
    assert.equal(interpretSession(result).state, "unknown");
  }
});

test("the model list is ready only for a 200 with usable entries", () => {
  const ready = interpretModels({
    status: 200,
    body: { models: [{ id: "a/one", name: "One" }, { id: "a/two" }, { id: "a/one", name: "Dup" }, { id: "" }, null, { name: "no id" }] },
  });
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.models, [
    { id: "a/one", label: "One (a/one)" },
    { id: "a/two", label: "a/two" },
  ]);
  assert.equal(interpretModels({ status: 200, body: { models: [] } }).state, "empty");
});

test("every other model-list answer leaves the selector unavailable", () => {
  for (const result of [
    { status: 401, body: { error: "Sign in required" } },
    { status: 404, body: { error: "Not found" } },
    { status: 503, body: { models: [{ id: "a/one" }] } },
    { status: 200, body: { models: "nope" } },
    { status: 200, body: null },
    { status: 200 },
    { networkError: true },
    undefined,
  ]) {
    const view = interpretModels(result);
    assert.equal(view.state, "unavailable");
    assert.deepEqual(view.models, []);
  }
  assert.equal(interpretModels({ status: 200, body: { models: [{ id: "x".repeat(201) }] } }).state, "empty");
});

test("only a model still in the loaded list is sent; otherwise the choice is automatic", () => {
  const models = [{ id: "a/one" }, { id: "a/two" }];
  assert.equal(modelToSend("a/two", models), "a/two");
  assert.equal(modelToSend("a/gone", models), undefined);
  assert.equal(modelToSend("", models), undefined);
  assert.equal(modelToSend(undefined, models), undefined);
  assert.equal(modelToSend("a/one", []), undefined);
});

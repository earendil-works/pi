import test from "node:test";
import assert from "node:assert/strict";

import { createStatusPayload } from "../src/status.js";

const fixedNow = () => new Date("2026-11-06T12:00:00.000Z");

test("everything is reported off when no flags are set", () => {
  const status = createStatusPayload({ env: {}, now: fixedNow });

  assert.equal(status.service, "nlt-pi-mvp");
  assert.equal(status.runtime, "disabled");
  assert.equal(status.execution, "disabled");
  assert.equal(status.executionEnabled, false);
  assert.equal(status.egress, "none");
  assert.equal(status.history, "disabled");
  assert.equal(status.checkedAt, "2026-11-06T12:00:00.000Z");
});

test("runtime and execution follow NLT_AGENT_ENABLED=1 only", () => {
  const on = createStatusPayload({ env: { NLT_AGENT_ENABLED: "1" } });
  assert.equal(on.runtime, "enabled");
  assert.equal(on.execution, "enabled");
  assert.equal(on.executionEnabled, true);

  for (const value of ["0", "true", "yes", "", " 1", undefined]) {
    const off = createStatusPayload({ env: { NLT_AGENT_ENABLED: value } });
    assert.equal(off.runtime, "disabled", `value ${JSON.stringify(value)}`);
    assert.equal(off.executionEnabled, false, `value ${JSON.stringify(value)}`);
  }
});

test("egress is reported only while the agent is on, and allow-all needs its own flag", () => {
  assert.equal(createStatusPayload({ env: { NLT_AGENT_EGRESS_ALL: "1" } }).egress, "none");
  assert.equal(createStatusPayload({ env: { NLT_AGENT_ENABLED: "1" } }).egress, "allowlist");
  assert.equal(createStatusPayload({ env: { NLT_AGENT_ENABLED: "1", NLT_AGENT_EGRESS_ALL: "1" } }).egress, "allow-all");
});

test("history follows NLT_HISTORY_ENABLED=1", () => {
  assert.equal(createStatusPayload({ env: { NLT_HISTORY_ENABLED: "1" } }).history, "enabled");
  assert.equal(createStatusPayload({ env: { NLT_HISTORY_ENABLED: "true" } }).history, "disabled");
});

test("status never claims governance verification unless told, and execution cannot be forced by an argument", () => {
  const status = createStatusPayload({ env: {}, executionEnabled: true, runtime: "enabled" });
  assert.equal(status.governance, "not-verified");
  assert.equal(status.executionEnabled, false);
  assert.equal(createStatusPayload({ env: {}, governanceVerified: true }).governance, "verified");
});

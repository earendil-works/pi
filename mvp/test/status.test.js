import test from "node:test";
import assert from "node:assert/strict";

import { createStatusPayload } from "../src/status.js";

test("status reports the runtime and governance as unverified by default", () => {
  const status = createStatusPayload();

  assert.equal(status.service, "nlt-pi-mvp");
  assert.equal(status.runtime, "not-integrated");
  assert.equal(status.governance, "not-verified");
});

test("execution remains disabled even when readiness flags are supplied", () => {
  const status = createStatusPayload({
    runtimeIntegrated: true,
    governanceVerified: true,
    executionEnabled: true,
  });

  assert.equal(status.execution, "disabled");
  assert.equal(status.executionEnabled, false);
});

test("status does not claim governance verification when only runtime is integrated", () => {
  const status = createStatusPayload({ runtimeIntegrated: true });

  assert.equal(status.runtime, "integrated");
  assert.equal(status.governance, "not-verified");
  assert.equal(status.executionEnabled, false);
});

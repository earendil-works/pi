import test from "node:test";
import assert from "node:assert/strict";

import healthHandler from "../api/health.js";
import statusHandler from "../api/status.js";

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("health endpoint returns a minimal healthy response for GET", () => {
  const response = createResponse();

  healthHandler({ method: "GET" }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    service: "nlt-pi-mvp",
    status: "ok",
  });
});

test("health endpoint rejects non-GET methods", () => {
  const response = createResponse();

  healthHandler({ method: "POST" }, response);

  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "GET");
});

function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("status endpoint fails closed when no switches are set", () => {
  withEnv({ NLT_AGENT_ENABLED: undefined, NLT_AGENT_EGRESS_ALL: undefined, NLT_HISTORY_ENABLED: undefined }, () => {
    const response = createResponse();

    statusHandler({ method: "GET" }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.runtime, "disabled");
    assert.equal(response.body.governance, "not-verified");
    assert.equal(response.body.executionEnabled, false);
  });
});

test("status endpoint reports live state from the server's switches", () => {
  withEnv({ NLT_AGENT_ENABLED: "1", NLT_AGENT_EGRESS_ALL: undefined, NLT_HISTORY_ENABLED: "1" }, () => {
    const response = createResponse();

    statusHandler({ method: "GET" }, response);

    assert.equal(response.body.runtime, "enabled");
    assert.equal(response.body.executionEnabled, true);
    assert.equal(response.body.egress, "allowlist");
    assert.equal(response.body.history, "enabled");
    assert.equal(response.body.governance, "not-verified");
  });
});

test("status endpoint rejects non-GET methods", () => {
  const response = createResponse();

  statusHandler({ method: "POST" }, response);

  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "GET");
});

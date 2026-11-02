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

test("status endpoint returns fail-closed integration state for GET", () => {
  const response = createResponse();

  statusHandler({ method: "GET" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.runtime, "not-integrated");
  assert.equal(response.body.governance, "not-verified");
  assert.equal(response.body.executionEnabled, false);
});

test("status endpoint rejects non-GET methods", () => {
  const response = createResponse();

  statusHandler({ method: "POST" }, response);

  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "GET");
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runPrepare(env) {
  return spawnSync(process.execPath, ["scripts/prepare-husky.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("prepare skips Husky when CI omits development dependencies", () => {
  const result = runPrepare({ CI: "true", NODE_ENV: "development" });

  assert.equal(result.status, 0, result.stderr);
});

test("prepare skips Husky for production installs", () => {
  const result = runPrepare({ CI: "", NODE_ENV: "production" });

  assert.equal(result.status, 0, result.stderr);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(repositoryRoot, ".nltotoi/scripts/validate-governance.sh");

test("NLT-Pi governance validator accepts the repository's public-baseline implementation", () => {
  const result = spawnSync("bash", [validator], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `validator failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /public template provenance/);
  assert.match(result.stdout, /Results: \d+ passed, 0 failed/);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const script = join(scripts, "preview-packages-push.sh");
// The pattern the workflow passes, read from it so the test checks the real one.
const workflow = readFileSync(join(scripts, "../.github/workflows/preview-packages.yml"), "utf8");
const RELEASE_TAG = /^\s*RELEASE_TAG: '(.+)'$/m.exec(workflow)[1];
const sha = "a".repeat(40);
const mainSha = "m".repeat(40);
const repo = "repos/earendil-works/pi";

/**
 * Runs the script for a CI push run against a fake `gh` that answers `gh api <path>` with `responses[path]`, already
 * filtered as by --jq, and fails like a 404 for any other path.
 */
async function decide(t, branch, responses) {
	const bin = mkdtempSync(join(tmpdir(), "pi-preview-packages-push-test-"));
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	writeFileSync(join(bin, "responses.json"), JSON.stringify(responses));
	const fake = `#!/usr/bin/env node
const responses = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(join(bin, "responses.json"))}, "utf8"));
const path = process.argv[3];
if (!(path in responses)) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
console.log(responses[path]);
`;
	writeFileSync(join(bin, "gh"), fake);
	chmodSync(join(bin, "gh"), 0o755);
	const env = {
		PATH: `${bin}:${process.env.PATH}`,
		GITHUB_REPOSITORY: "earendil-works/pi",
		HEAD_SHA: sha,
		HEAD_BRANCH: branch,
		RELEASE_TAG,
	};
	try {
		const { stdout } = await run("bash", [script], { env });
		return { args: stdout.split("\n").filter(Boolean) };
	} catch (error) {
		return { failed: error.stderr.trim() };
	}
}

/** GitHub's answers for a commit on main: compare against main's SHA says how the commit relates to it. */
function onMain(status = "behind") {
	return { [`${repo}/git/ref/heads/main`]: mainSha, [`${repo}/compare/${mainSha}...${sha}`]: status };
}

test("publishes main and release tags of commits on main", async (t) => {
	const lightweight = { ...onMain(), [`${repo}/git/ref/tags/v1.2.3`]: `commit ${sha}` };
	assert.deepEqual(await decide(t, "main", onMain("identical")), { args: ["--ref", "main"] });
	assert.deepEqual(await decide(t, "v1.2.3", lightweight), { args: ["--tag", "v1.2.3", "--ref", "latest"] });

	// An annotated tag can point at another annotated tag before the commit.
	const nested = {
		...onMain(),
		[`${repo}/git/ref/tags/v1.2.3`]: "tag t1",
		[`${repo}/git/tags/t1`]: "tag t2",
		[`${repo}/git/tags/t2`]: `commit ${sha}`,
	};
	assert.deepEqual(await decide(t, "v1.2.3", nested), { args: ["--tag", "v1.2.3", "--ref", "latest"] });

	// A pre-release is released, but `latest` stays on the newest release.
	const prerelease = { ...onMain(), [`${repo}/git/ref/tags/v1.2.3-rc.1`]: `commit ${sha}` };
	assert.deepEqual(await decide(t, "v1.2.3-rc.1", prerelease), { args: ["--tag", "v1.2.3-rc.1"] });
});

test("publishes nothing for names that are no release tag", async (t) => {
	for (const branch of ["vfoo", "v1.2", "release-1.2.3"]) {
		assert.deepEqual([branch, await decide(t, branch, onMain())], [branch, { args: [] }]);
	}
});

test("refuses commits off main, tags of other commits and failed checks", async (t) => {
	const tagged = { [`${repo}/git/ref/tags/v1.2.3`]: `commit ${sha}` };
	const cases = [
		// A tag named main on an unreviewed commit: a bare `main` in compare would resolve to the tag.
		["tag named main", "main", { ...onMain("diverged"), [`${repo}/compare/main...${sha}`]: "identical" }],
		["release tag off main", "v1.2.3", { ...onMain("ahead"), ...tagged }],
		["tag of another commit", "v1.2.3", { ...onMain(), [`${repo}/git/ref/tags/v1.2.3`]: `commit ${"b".repeat(40)}` }],
		["missing tag", "v1.2.3", onMain()],
		["main not found", "main", {}],
		["compare failed", "v1.2.3", { [`${repo}/git/ref/heads/main`]: mainSha, ...tagged }],
	];
	for (const [label, branch, responses] of cases) {
		const result = await decide(t, branch, responses);
		assert.ok(result.failed, `${label}: expected a refusal, got ${JSON.stringify(result)}`);
	}
});

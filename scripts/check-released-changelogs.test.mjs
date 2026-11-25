import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-released-changelogs.mjs", import.meta.url));

const RELEASED = "## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Fixed the first bug\n";

/** A repository with one published package whose changelog was released as 1.0.0 and tagged v1.0.0. */
function releasedRepository(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-released-changelogs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	mkdirSync(join(root, "packages", "ai"), { recursive: true });
	writeFileSync(join(root, "packages", "ai", "package.json"), '{"name":"@test/ai","version":"1.0.0"}\n');
	writeFileSync(join(root, "packages", "ai", "CHANGELOG.md"), `# Changelog\n\n${RELEASED}`);
	git("init", "--quiet");
	git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "Release v1.0.0");
	git("tag", "v1.0.0");
	return root;
}

function writeChangelog(root, text) {
	writeFileSync(join(root, "packages", "ai", "CHANGELOG.md"), text);
}

function check(root) {
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

test("passes when new entries are under [Unreleased]", (t) => {
	const root = releasedRepository(t);
	writeChangelog(root, `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed a new bug\n\n${RELEASED}`);
	const result = check(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /match v1\.0\.0/);
});

// Entries of PR #11975, merged after v1.5.1, landed under [1.5.1].
test("fails when an entry was added to a released section, naming the section", (t) => {
	const root = releasedRepository(t);
	const changelog = readFileSync(join(root, "packages", "ai", "CHANGELOG.md"), "utf8");
	writeChangelog(
		root,
		changelog.replace("## [1.0.0]", "## [Unreleased]\n\n## [1.0.0]").replace(
			"- Fixed the first bug\n",
			"- Fixed the first bug\n- Fixed a later bug\n",
		),
	);
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /packages\/ai\/CHANGELOG\.md: released sections differ from v1\.0\.0/);
	assert.match(result.stderr, /\+ \[1\.0\.0\] - Fixed a later bug/);
});

test("fails when an entry was removed from a released section", (t) => {
	const root = releasedRepository(t);
	writeChangelog(root, "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n");
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /- - Fixed the first bug/);
});

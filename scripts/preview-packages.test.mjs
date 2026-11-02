import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "preview-packages.mjs");
const sha = "a".repeat(40);
const newerSha = "b".repeat(40);
const mainSha = "c".repeat(40);
const REPO_API = "/repos/earendil-works/pi/";

function temporaryDirectory(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-preview-packages-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function writePackage(repo, directory, manifest) {
	mkdirSync(join(repo, "packages", directory), { recursive: true });
	writeFileSync(join(repo, "packages", directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

/** GitHub's answers for a commit on main: compare against main's SHA says how the commit relates to main. */
function onMain(status = "behind") {
	return { "git/ref/heads/main": { object: { sha: mainSha } }, [`compare/${mainSha}...${sha}`]: { status } };
}

/** GitHub's answers for a release tag of the commit on main. */
function released(tag) {
	return { ...onMain(), [`git/ref/tags/${tag}`]: { object: { type: "commit", sha } } };
}

/**
 * Stands in for the pkg.earendil.com worker, GitHub's OIDC token endpoint and GitHub's REST API, recording requests.
 * `refsSha` is what the worker reports each ref resolves to after the update; `uploadBody` overrides the upload
 * response; `releaseStatus` the release's status. `github` maps paths below the repository to API responses; any other
 * API path is a 404.
 */
async function startServer(t, { refsSha = sha, uploadBody, releaseStatus = 201, github = {} } = {}) {
	const requests = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
		const url = new URL(req.url, "http://localhost");
		if (url.pathname === "/token") return res.end(JSON.stringify({ value: `oidc-for-${url.searchParams.get("audience")}` }));
		if (url.pathname.startsWith(REPO_API)) {
			const response = github[url.pathname.slice(REPO_API.length)];
			res.statusCode = response ? 200 : 404;
			return res.end(JSON.stringify(response ?? { message: "Not Found" }));
		}
		if (req.method === "PUT") {
			const name = decodeURIComponent(url.pathname.split("/").slice(4).join("/"));
			return res.end(uploadBody ?? JSON.stringify({ name, sha, existing: false }));
		}
		if (url.pathname === "/_/releases") {
			const { tag } = JSON.parse(body);
			res.statusCode = releaseStatus;
			const packages = [{ name: "@scope/a", url: `http://pkg/@scope/a@${tag}` }];
			return res.end(JSON.stringify(releaseStatus === 201 ? { tag, sha, packages, existing: false } : { error: "no" }));
		}
		const { refs } = JSON.parse(body);
		res.end(JSON.stringify({ refs: refs.map((ref) => ({ ref, sha: refsSha })) }));
	});
	await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
	t.after(() => server.close());
	return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function writeArtifact(directory) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "scope-a-1.0.0.tgz"), "tarball a");
	const packages = [{ name: "@scope/a", file: "scope-a-1.0.0.tgz" }];
	writeFileSync(join(directory, "manifest.json"), JSON.stringify({ sha, packages }));
}

function publish(server, dir, args = ["--event", "pull_request", "--ref", "pr-1"]) {
	const { GITHUB_STEP_SUMMARY: _, ...env } = process.env;
	const common = ["publish", "--sha", sha, "--run", "7", "--dir", dir];
	return run(process.execPath, [script, ...common, ...args, "--base-url", server.url], {
		env: {
			...env,
			ACTIONS_ID_TOKEN_REQUEST_URL: `${server.url}/token`,
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner",
			GITHUB_API_URL: server.url,
			GITHUB_REPOSITORY: "earendil-works/pi",
			GH_TOKEN: "job-token",
		},
	});
}

/** The arguments of a CI push run of `branch`. */
function pushRun(branch, conclusion = "success") {
	return ["--event", "push", "--branch", branch, "--conclusion", conclusion];
}

/** The POST requests to pkg.earendil.com, as [path, body]. */
function posts(server) {
	const requests = server.requests.filter((request) => request.method === "POST");
	return requests.map((request) => [request.url, JSON.parse(request.body)]);
}

test("pack points internal dependencies at the commit's builds and restores package.json", async (t) => {
	const repo = temporaryDirectory(t);
	writePackage(repo, "a", { name: "@scope/a", version: "1.0.0", dependencies: { "@scope/b": "1.0.0", other: "2.0.0" } });
	writePackage(repo, "b", { name: "@scope/b", version: "1.0.0" });
	writePackage(repo, "internal", { name: "@scope/internal", version: "1.0.0", private: true });
	writePackage(repo, "env", { name: "@earendil-works/pi-env", version: "1.0.0" });
	const original = readFileSync(join(repo, "packages/a/package.json"), "utf8");

	const out = join(repo, "out");
	await run(process.execPath, [script, "pack", "--sha", sha, "--out", out], { cwd: repo });

	const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
	assert.equal(manifest.sha, sha);
	assert.deepEqual(manifest.packages.map((pkg) => pkg.name).sort(), ["@scope/a", "@scope/b"]);
	assert.deepEqual(readdirSync(out).sort(), ["manifest.json", ...manifest.packages.map((pkg) => pkg.file)].sort());
	const fileA = manifest.packages.find((pkg) => pkg.name === "@scope/a").file;
	const packedA = JSON.parse(execFileSync("tar", ["-xOzf", join(out, fileA), "package/package.json"], { encoding: "utf8" }));
	assert.deepEqual(packedA.dependencies, { "@scope/b": `https://pkg.earendil.com/@scope/b@${sha}`, other: "2.0.0" });
	assert.equal(readFileSync(join(repo, "packages/a/package.json"), "utf8"), original);
});

test("publish uploads each tarball, moves refs and prints install commands", async (t) => {
	const server = await startServer(t);
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	const { stdout } = await publish(server, dir);

	const [token, upload, refs] = server.requests;
	assert.equal(token.url, "/token?audience=https%3A%2F%2Fpkg.earendil.com");
	assert.deepEqual(
		{ method: upload.method, url: upload.url, authorization: upload.authorization, body: upload.body },
		{
			method: "PUT",
			url: `/_/upload/${sha}/%40scope%2Fa?event=pull_request`,
			authorization: "Bearer oidc-for-https://pkg.earendil.com",
			body: "tarball a",
		},
	);
	assert.deepEqual(JSON.parse(refs.body), { sha, refs: ["pr-1"], run: 7 });
	assert.match(stdout, new RegExp(`npm i ${server.url}/@scope/a@pr-1`));
	assert.match(stdout, new RegExp(`npm i ${server.url}/@scope/a@${sha}`));
});

test("publish leaves the summary to a newer run that already owns the ref", async (t) => {
	const server = await startServer(t, { refsSha: newerSha });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	const { stdout, stderr } = await publish(server, dir);
	assert.equal(stdout, "");
	assert.match(stderr, new RegExp(`a newer run already published pr-1 \\(${newerSha}\\)`));
});

test("publish fails on a successful response that is not JSON", async (t) => {
	const server = await startServer(t, { uploadBody: "<html>proxy</html>" });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	await assert.rejects(publish(server, dir), /not valid JSON/);
	assert.equal(server.requests.filter((request) => request.method === "POST").length, 0);
});

test("publish decides what a push run publishes", async (t) => {
	const release = (tag) => ["/_/releases", { sha, tag }];
	const latest = ["/_/refs", { sha, refs: ["latest"], run: 7 }];
	const nested = {
		...onMain(),
		"git/ref/tags/v1.2.3": { object: { type: "tag", sha: "t1" } },
		"git/tags/t1": { object: { type: "tag", sha: "t2" } },
		"git/tags/t2": { object: { type: "commit", sha } },
	};
	const cases = [
		["main", onMain("identical"), [["/_/refs", { sha, refs: ["main"], run: 7 }]]],
		["v1.2.3", released("v1.2.3"), [release("v1.2.3"), latest]],
		// An annotated tag can point at another annotated tag before the commit.
		["v1.2.3", nested, [release("v1.2.3"), latest]],
		// A pre-release is kept under its tag, but `latest` stays on the newest release.
		["v1.2.3-beta.1", released("v1.2.3-beta.1"), [release("v1.2.3-beta.1")]],
	];
	for (const [branch, github, expected] of cases) {
		const server = await startServer(t, { github });
		const dir = join(temporaryDirectory(t), "artifact");
		writeArtifact(dir);
		await publish(server, dir, pushRun(branch));
		assert.deepEqual([branch, posts(server)], [branch, expected]);
	}
});

test("publish uploads nothing for push runs of other names", async (t) => {
	for (const branch of ["vfoo", "v1.2", "v1.2.3.4", "release-v1.2.3", "v1.2.3-"]) {
		const server = await startServer(t, { github: released(branch) });
		const dir = join(temporaryDirectory(t), "artifact");
		writeArtifact(dir);
		const { stderr } = await publish(server, dir, pushRun(branch));
		assert.match(stderr, /nothing to publish/);
		assert.deepEqual([branch, server.requests], [branch, []]);
	}
});

test("publish refuses push runs off main, of other commits or with failing CI", async (t) => {
	const otherCommit = { ...onMain(), "git/ref/tags/v1.2.3": { object: { type: "commit", sha: newerSha } } };
	const cases = [
		// A tag named main on an unreviewed commit: a bare `main` in compare would resolve to the tag.
		["tag named main", "main", "success", { ...onMain("diverged"), [`compare/main...${sha}`]: { status: "identical" } }],
		["release tag off main", "v1.2.3", "success", { ...released("v1.2.3"), ...onMain("ahead") }],
		["tag of another commit", "v1.2.3", "success", otherCommit],
		["missing tag", "v1.2.3", "success", onMain()],
		["failing CI", "v1.2.3", "failure", released("v1.2.3")],
	];
	for (const [label, branch, conclusion, github] of cases) {
		const server = await startServer(t, { github });
		const dir = join(temporaryDirectory(t), "artifact");
		writeArtifact(dir);
		await assert.rejects(publish(server, dir, pushRun(branch, conclusion)), undefined, label);
		const uploads = server.requests.filter((request) => request.method === "PUT");
		assert.deepEqual([label, uploads], [label, []]);
	}
});

const RELEASE_RUN = pushRun("v1.2.3");

test("publish prints the release's install commands", async (t) => {
	const server = await startServer(t, { github: released("v1.2.3") });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	const { stdout } = await publish(server, dir, RELEASE_RUN);
	assert.match(stdout, new RegExp(`npm i ${server.url}/@scope/a@v1\\.2\\.3`));
	assert.match(stdout, new RegExp(`npm i ${server.url}/@scope/a@latest`));
});

test("publish moves no refs when the release fails", async (t) => {
	const server = await startServer(t, { releaseStatus: 409, github: released("v1.2.3") });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	await assert.rejects(publish(server, dir, RELEASE_RUN), /409/);
	assert.equal(server.requests.filter((request) => request.url === "/_/refs").length, 0);
});

test("publish still prints the release when a newer release owns latest", async (t) => {
	const server = await startServer(t, { refsSha: newerSha, github: released("v1.2.3") });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	const { stdout } = await publish(server, dir, RELEASE_RUN);
	assert.match(stdout, /@scope\/a@v1\.2\.3/);
	assert.doesNotMatch(stdout, /@latest/);
});

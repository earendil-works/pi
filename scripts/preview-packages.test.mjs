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

function temporaryDirectory(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-preview-packages-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function writePackage(repo, directory, manifest) {
	mkdirSync(join(repo, "packages", directory), { recursive: true });
	writeFileSync(join(repo, "packages", directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

/**
 * Stands in for the pkg.earendil.com worker and GitHub's OIDC token endpoint, recording requests. `refsSha` is what the
 * worker reports each ref resolves to after the update; `uploadBody` overrides the upload response; `releaseStatus`
 * the release's status.
 */
async function startServer(t, { refsSha = sha, uploadBody, releaseStatus = 201 } = {}) {
	const requests = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
		const url = new URL(req.url, "http://localhost");
		if (url.pathname === "/token") return res.end(JSON.stringify({ value: `oidc-for-${url.searchParams.get("audience")}` }));
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
		env: { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: `${server.url}/token`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner" },
	});
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

const RELEASE_ARGS = ["--event", "push", "--tag", "v1.2.3", "--ref", "latest"];

test("publish releases a tag before moving refs and prints its install commands", async (t) => {
	const server = await startServer(t);
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	const { stdout } = await publish(server, dir, RELEASE_ARGS);

	const posts = server.requests.filter((request) => request.method === "POST");
	assert.deepEqual(
		posts.map((request) => [request.url, JSON.parse(request.body)]),
		[
			["/_/releases", { sha, tag: "v1.2.3" }],
			["/_/refs", { sha, refs: ["latest"], run: 7 }],
		],
	);
	assert.match(stdout, new RegExp(`npm i ${server.url}/@scope/a@v1\\.2\\.3`));
	assert.match(stdout, new RegExp(`npm i ${server.url}/@scope/a@latest`));
});

test("publish moves no refs when the release fails", async (t) => {
	const server = await startServer(t, { releaseStatus: 409 });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	await assert.rejects(publish(server, dir, RELEASE_ARGS), /409/);
	assert.equal(server.requests.filter((request) => request.url === "/_/refs").length, 0);
});

test("publish still prints the release when a newer release owns latest", async (t) => {
	const server = await startServer(t, { refsSha: newerSha });
	const dir = join(temporaryDirectory(t), "artifact");
	writeArtifact(dir);

	const { stdout } = await publish(server, dir, RELEASE_ARGS);
	assert.match(stdout, /@scope\/a@v1\.2\.3/);
	assert.doesNotMatch(stdout, /@latest/);
});

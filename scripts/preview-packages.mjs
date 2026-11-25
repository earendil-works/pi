#!/usr/bin/env node
// Preview builds of pi's packages on pkg.earendil.com, served by the earendil-works/pkg worker.
// Used by .github/workflows/ci.yml (pack) and .github/workflows/preview-packages.yml (publish, delete-ref).
//
//   pack        Point internal dependencies at this commit's builds, then `npm pack` every public package.
//               Runs in the regular CI job after the build.
//   publish     Upload the packed tarballs and move refs (main, pr-1234), or release a tag (v1.2.3) and move `latest`.
//               Runs in the trusted workflow_run job and authenticates with the job's GitHub OIDC token
//               (`permissions: id-token: write`). A release keeps the packages for good under the tag.
//   delete-ref  Remove a ref, e.g. pr-1234 when the PR closes.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execNpmSync } from "./npm-command.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const BASE_URL = "https://pkg.earendil.com";
const FULL_SHA = /^[0-9a-f]{40}$/;
// Release tags as CI builds them (v*.*.*); a suffix marks a pre-release (v1.2.3-rc.1).
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
// Its daemon binaries are cross-compiled only by the release workflow; previews would ship without them.
const EXCLUDED = new Set(["@earendil-works/pi-env"]);

class UsageError extends Error {}

function assertSha(sha) {
	if (typeof sha !== "string" || !FULL_SHA.test(sha)) {
		throw new UsageError(`--sha must be a full commit SHA, got ${sha}`);
	}
}

async function pack(argv) {
	const { values } = parseArgs({
		args: argv,
		options: { sha: { type: "string" }, out: { type: "string", default: "preview-packages" } },
	});
	assertSha(values.sha);
	const sha = values.sha;
	const packages = getPublicWorkspacePackages().filter((pkg) => !EXCLUDED.has(pkg.name));
	const names = new Set(packages.map((pkg) => pkg.name));
	const outDir = resolve(values.out);
	await mkdir(outDir, { recursive: true });

	const packed = [];
	for (const pkg of packages) {
		const manifestPath = join(pkg.directory, "package.json");
		const original = await readFile(manifestPath, "utf8");
		const manifest = JSON.parse(original);
		// Internal dependencies point at the same commit's builds, so one install resolves a consistent set.
		for (const field of ["dependencies", "optionalDependencies"]) {
			for (const name of Object.keys(manifest[field] ?? {})) {
				if (names.has(name)) manifest[field][name] = `${BASE_URL}/${name}@${sha}`;
			}
		}
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		try {
			const output = execNpmSync(["pack", "--json", "--ignore-scripts", "--pack-destination", outDir], {
				cwd: pkg.directory,
				encoding: "utf8",
				stdio: ["inherit", "pipe", "inherit"],
				maxBuffer: 64 * 1024 * 1024,
			});
			// npm 10/11 print an array, npm 12 prints an object keyed by package name.
			const parsed = JSON.parse(output);
			const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
			packed.push({ name: info.name, file: info.filename });
			console.error(`packed ${info.name}@${info.version} -> ${info.filename}`);
		} finally {
			await writeFile(manifestPath, original);
		}
	}
	await writeFile(join(outDir, "manifest.json"), `${JSON.stringify({ sha, packages: packed }, null, "\t")}\n`);
}

// The audience names the production worker, also when --base-url points elsewhere (tests).
async function getOidcToken() {
	const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!url || !token) {
		throw new UsageError("No GitHub OIDC token available; the job needs `permissions: id-token: write`");
	}
	const requestUrl = new URL(url);
	requestUrl.searchParams.set("audience", BASE_URL);
	const response = await fetch(requestUrl, { headers: { authorization: `Bearer ${token}` } });
	if (!response.ok) throw new Error(`Requesting OIDC token failed: ${response.status}`);
	const { value } = await response.json();
	return value;
}

async function call(method, url, token, body) {
	const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}` }, body });
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${url} failed: ${response.status} ${text}`);
	return JSON.parse(text);
}

/** Reads `path` of this repository from the GitHub REST API with the job's token. */
function github(path) {
	const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
	return call("GET", `${api}/repos/${process.env.GITHUB_REPOSITORY}/${path}`, process.env.GH_TOKEN);
}

/**
 * Decides what a CI push run publishes: `main`, a release tag with `latest` (without it for a pre-release), or nothing
 * for any other name. A tag push's branch is the tag's name, and a branch or tag can carry its own copy of CI, so a
 * tag named `main` or `v1.2.3` on an unreviewed commit would pass a name check: the commit must also be on main, and a
 * release tag must point at it.
 */
async function pushTarget({ branch, sha, conclusion }) {
	if (branch === "main") {
		await assertOnMain(sha);
		return { refs: ["main"] };
	}
	if (!RELEASE_TAG.test(branch)) return undefined;
	// CI packs before its tests run; a release is kept for good.
	if (conclusion !== "success") throw new Error(`CI for ${branch} did not pass; not releasing it`);
	await assertOnMain(sha);
	const target = await tagCommit(branch);
	if (target !== sha) throw new Error(`${branch} points at ${target}, not ${sha}`);
	return { tag: branch, refs: branch.includes("-") ? [] : ["latest"] };
}

// main is resolved as the branch: in compare, a tag named `main` would win over a bare `main`.
async function assertOnMain(sha) {
	const main = await github("git/ref/heads/main");
	const { status } = await github(`compare/${main.object.sha}...${sha}`);
	if (status !== "behind" && status !== "identical") throw new Error(`${sha} is not on main (${status})`);
}

// Annotated tags point at a tag object, which can point at another tag.
async function tagCommit(tag) {
	let { object } = await github(`git/ref/tags/${tag}`);
	while (object.type === "tag") ({ object } = await github(`git/tags/${object.sha}`));
	return object.sha;
}

function renderSummary({ baseUrl, sha, release, refs, names }) {
	const lines = ["### Preview packages", "", `Built from \`${sha.slice(0, 7)}\`.`, ""];
	if (release) {
		lines.push(`Release \`${release.tag}\` (kept for good):`, "", "```sh");
		for (const { name } of release.packages) lines.push(`npm i ${baseUrl}/${name}@${release.tag}`);
		lines.push("```", "");
	}
	if (refs.length > 0) {
		lines.push(`Latest build of \`${refs[0]}\` (moves with newer builds):`, "", "```sh");
		for (const name of names) lines.push(`npm i ${baseUrl}/${name}@${refs[0]}`);
		lines.push("```", "");
	}
	lines.push("<details><summary>Pinned to this commit</summary>", "", "```sh");
	for (const name of names) lines.push(`npm i ${baseUrl}/${name}@${sha}`);
	lines.push("```", "", "</details>", "");
	lines.push(`Installs need a token in \`.npmrc\`: \`//${new URL(baseUrl).host}/:_authToken=...\``);
	return `${lines.join("\n")}\n`;
}

async function publish(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			dir: { type: "string", default: "preview-packages" },
			sha: { type: "string" },
			ref: { type: "string", multiple: true, default: [] },
			branch: { type: "string" },
			conclusion: { type: "string" },
			run: { type: "string" },
			event: { type: "string" },
			"base-url": { type: "string", default: BASE_URL },
		},
	});
	assertSha(values.sha);
	const { sha, event } = values;
	const run = Number(values.run);
	if (!/^\d+$/.test(values.run ?? "") || !Number.isSafeInteger(run)) {
		throw new UsageError(`--run must be the CI run ID, got ${values.run}`);
	}
	if (event !== "push" && event !== "pull_request") {
		throw new UsageError(`--event must be push or pull_request, got ${event}`);
	}
	if (event === "push" && !values.branch) throw new UsageError("Push runs need --branch");
	const baseUrl = values["base-url"];
	const dir = resolve(values.dir);
	// Push runs are checked before anything is uploaded; pull request runs move the refs the workflow passes.
	const target = event === "push" ? await pushTarget(values) : { refs: values.ref };
	if (!target) {
		console.error(`::notice::${values.branch} is neither main nor a release tag; nothing to publish`);
		return;
	}
	const { tag, refs } = target;

	// The artifact comes from an untrusted PR build: only read tarballs from it. The SHA, run, event, and refs
	// come from the trusted workflow_run event; the worker authorizes package names against its config.
	const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
	if (manifest.sha !== sha) throw new Error(`Artifact was packed for ${manifest.sha}, expected ${sha}`);
	if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("Artifact has no packages");

	const token = await getOidcToken();
	const names = [];
	for (const { name, file } of manifest.packages) {
		if (typeof file !== "string" || basename(file) !== file || !file.endsWith(".tgz")) {
			throw new Error(`Invalid tarball name in artifact: ${file}`);
		}
		const url = `${baseUrl}/_/upload/${sha}/${encodeURIComponent(name)}?event=${event}`;
		const result = await call("PUT", url, token, await readFile(join(dir, file)));
		names.push(result.name);
		console.error(`${result.existing ? "exists" : "uploaded"} ${result.name}@${sha}`);
	}
	// Release before moving refs, so `latest` never points at a commit whose release failed.
	const release = tag && (await call("POST", `${baseUrl}/_/releases`, token, JSON.stringify({ sha, tag })));
	if (release) console.error(`${release.existing ? "already released" : "released"} ${tag}`);
	let movedRefs = refs;
	if (refs.length > 0) {
		const result = await call("POST", `${baseUrl}/_/refs`, token, JSON.stringify({ sha, refs, run }));
		const newer = result.refs.filter((ref) => ref.sha !== sha);
		if (newer.length > 0) {
			// A newer run already published these refs; its summary has the current install commands.
			console.error(`a newer run already published ${newer.map((ref) => `${ref.ref} (${ref.sha})`).join(", ")}`);
			if (!tag) return;
			movedRefs = [];
		} else {
			console.error(`moved ${refs.join(", ")} to ${sha}`);
		}
	}

	const summary = renderSummary({ baseUrl, sha, release, refs: movedRefs, names: names.sort() });
	process.stdout.write(summary);
	if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

async function deleteRef(argv) {
	const { values } = parseArgs({
		args: argv,
		options: { ref: { type: "string" }, "base-url": { type: "string", default: BASE_URL } },
	});
	if (!values.ref) throw new UsageError("delete-ref needs --ref");
	await call("DELETE", `${values["base-url"]}/_/refs/${encodeURIComponent(values.ref)}`, await getOidcToken());
	console.error(`deleted ${values.ref}`);
}

const USAGE = `Usage:
  node scripts/preview-packages.mjs pack --sha <sha> [--out dir]
  node scripts/preview-packages.mjs publish --sha <sha> --run <CI run id> --event push --branch <name>
                                            --conclusion <CI conclusion> [--dir dir]
  node scripts/preview-packages.mjs publish --sha <sha> --run <CI run id> --event pull_request
                                            [--dir dir] [--ref name]...
  node scripts/preview-packages.mjs delete-ref --ref <name>`;

const [command, ...argv] = process.argv.slice(2);
const commands = { pack, publish, "delete-ref": deleteRef };
try {
	if (!commands[command]) throw new UsageError(USAGE);
	await commands[command](argv);
} catch (error) {
	console.error(error instanceof UsageError ? error.message : `preview-packages: ${error.message}`);
	process.exit(1);
}

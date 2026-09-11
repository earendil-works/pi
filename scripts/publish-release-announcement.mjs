#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const RELEASES_PREFIX = "releases/v1";
const INSTALLER_PREFIX = "installer/v1";
const INSTALLER_PACKAGE_NAME = "@earendil-works/pi-coding-agent-install";
const REGISTRY_URL = "https://registry.npmjs.org";
const RETRY_DELAY_MS = 5000;
const RETRY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_POINTER_UPDATE_ATTEMPTS = 5;
const STABLE_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseArgs(args) {
	const options = {
		bucket: undefined,
		endpoint: undefined,
		installerPackageJson: undefined,
		installerPackageLock: undefined,
		modelCatalog: undefined,
		sourceCommit: undefined,
		version: undefined,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (
			arg !== "--bucket" &&
			arg !== "--endpoint" &&
			arg !== "--installer-package-json" &&
			arg !== "--installer-package-lock" &&
			arg !== "--model-catalog" &&
			arg !== "--source-commit" &&
			arg !== "--version"
		) {
			throw new Error(`Unknown argument: ${arg}`);
		}
		const value = args[++index];
		if (!value) throw new Error(`${arg} requires a value`);
		options[
			{
				"--bucket": "bucket",
				"--endpoint": "endpoint",
				"--installer-package-json": "installerPackageJson",
				"--installer-package-lock": "installerPackageLock",
				"--model-catalog": "modelCatalog",
				"--source-commit": "sourceCommit",
				"--version": "version",
			}[arg]
		] = value;
	}

	if (!options.modelCatalog) throw new Error("--model-catalog is required");
	if (!options.bucket) throw new Error("--bucket is required");
	if (!options.endpoint) throw new Error("--endpoint is required");
	if (!options.version || !STABLE_SEMVER_RE.test(options.version)) {
		throw new Error("--version must be a stable semver version");
	}
	if (!options.installerPackageJson || !options.installerPackageLock) {
		throw new Error("--installer-package-json and --installer-package-lock are required");
	}
	return options;
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resolvePackageFromNpm(pkg) {
	const packageUrl = `${REGISTRY_URL}/${encodeURIComponent(pkg.name)}/${pkg.version}`;
	const response = await fetch(packageUrl, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`${pkg.name}@${pkg.version}: npm registry returned ${response.status}`);
	}

	const data = await response.json();
	if (
		typeof data !== "object" ||
		data === null ||
		Array.isArray(data) ||
		data.version !== pkg.version ||
		typeof data.dist !== "object" ||
		data.dist === null ||
		Array.isArray(data.dist) ||
		typeof data.dist.tarball !== "string" ||
		typeof data.dist.integrity !== "string"
	) {
		throw new Error(`${pkg.name}@${pkg.version}: npm registry returned invalid metadata`);
	}

	const tarball = await fetch(data.dist.tarball, { method: "HEAD" });
	if (!tarball.ok) {
		throw new Error(`${pkg.name}@${pkg.version}: tarball returned ${tarball.status}`);
	}

	return {
		name: pkg.name,
		version: pkg.version,
		tarball: data.dist.tarball,
		integrity: data.dist.integrity,
	};
}

async function verifyPackagesAreAvailable(packages) {
	const deadline = Date.now() + RETRY_TIMEOUT_MS;
	let attempt = 0;
	let failures = [];

	do {
		attempt++;
		const results = await Promise.allSettled(packages.map(resolvePackageFromNpm));
		failures = results.flatMap((result, index) =>
			result.status === "rejected" ? [`${packages[index].name}: ${result.reason}`] : [],
		);
		if (failures.length === 0) {
			console.log(`All ${packages.length} Pi packages are available from npm (attempt ${attempt}).`);
			return results.map((result) => result.value);
		}

		console.log(`Waiting for ${failures.length} Pi package${failures.length === 1 ? "" : "s"} on npm (attempt ${attempt}):`);
		for (const failure of failures) console.log(`  ${failure}`);
		if (Date.now() < deadline) await sleep(RETRY_DELAY_MS);
	} while (Date.now() < deadline);

	throw new Error(`Timed out waiting for Pi packages to become available from npm:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
}

function gitSourceCommit() {
	return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function runAws(args, { allowNotFound = false, allowPreconditionFailure = false } = {}) {
	const result = spawnSync("aws", args, {
		encoding: "utf8",
		env: {
			...process.env,
			AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
			AWS_EC2_METADATA_DISABLED: "true",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status === 0) return result.stdout;

	const message = `${result.stdout}\n${result.stderr}`.trim();
	if (allowNotFound && /(?:404|NoSuchKey|Not Found)/i.test(message)) return undefined;
	if (allowPreconditionFailure && /(?:412|PreconditionFailed|ConditionalRequestConflict)/i.test(message)) {
		return undefined;
	}
	throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n${message}`);
}

function readLatestRelease(bucket, endpoint, key, outputPath) {
	const head = runAws(
		[
			"s3api",
			"head-object",
			"--bucket",
			bucket,
			"--key",
			key,
			"--endpoint-url",
			endpoint,
		],
		{ allowNotFound: true },
	);
	if (head === undefined) return undefined;

	const metadata = JSON.parse(head);
	if (typeof metadata.ETag !== "string") {
		throw new Error("Latest Pi release marker has no ETag.");
	}
	runAws([
		"s3api",
		"get-object",
		"--bucket",
		bucket,
		"--key",
		key,
		"--endpoint-url",
		endpoint,
		outputPath,
	]);
	const release = JSON.parse(readFileSync(outputPath, "utf8"));
	if (
		typeof release !== "object" ||
		release === null ||
		Array.isArray(release) ||
		typeof release.version !== "string" ||
		!STABLE_SEMVER_RE.test(release.version)
	) {
		throw new Error("Latest Pi release marker has an invalid version.");
	}
	return { etag: metadata.ETag, version: release.version };
}

function putObject(bucket, endpoint, path, key, cacheControl, condition) {
	const args = [
		"s3api",
		"put-object",
		"--bucket",
		bucket,
		"--key",
		key,
		"--body",
		path,
		"--endpoint-url",
		endpoint,
		"--content-type",
		"application/json; charset=utf-8",
		"--cache-control",
		cacheControl,
	];
	if (condition?.etag) args.push("--if-match", condition.etag);
	if (condition?.missing) args.push("--if-none-match", "*");
	return runAws(args, { allowPreconditionFailure: Boolean(condition) }) !== undefined;
}

function putJson(bucket, endpoint, path, key, cacheControl, condition) {
	return putObject(bucket, endpoint, path, key, cacheControl, condition);
}

function validateInstallerArtifacts(packageJsonPath, packageLockPath, version) {
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
	const root = packageLock.packages?.[""];

	if (packageJson.name !== INSTALLER_PACKAGE_NAME || packageJson.version !== version) {
		throw new Error(`Installer package.json must describe ${INSTALLER_PACKAGE_NAME}@${version}`);
	}
	if (
		packageLock.lockfileVersion !== 3 ||
		packageLock.version !== version ||
		root?.version !== version ||
		root.dependencies?.["@earendil-works/pi-coding-agent"] !== version
	) {
		throw new Error(`Installer package-lock.json must describe Pi ${version}`);
	}
}

export function compareReleaseVersions(left, right) {
	const leftMatch = STABLE_SEMVER_RE.exec(left);
	const rightMatch = STABLE_SEMVER_RE.exec(right);
	if (!leftMatch || !rightMatch) throw new Error("Release versions must be stable semver versions.");

	for (const index of [1, 2, 3]) {
		const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
		if (difference !== 0) return difference;
	}
	return 0;
}

export async function advanceLatestRelease(version, readLatest, writeLatest) {
	for (let attempt = 0; attempt < MAX_POINTER_UPDATE_ATTEMPTS; attempt++) {
		const current = await readLatest();
		if (current && compareReleaseVersions(version, current.version) <= 0) {
			return { advanced: false, version: current.version };
		}

		const updated = await writeLatest(current ? { etag: current.etag } : { missing: true });
		if (updated) {
			return { advanced: true, version };
		}
	}
	throw new Error(`Could not advance the Pi release marker to ${version} after ${MAX_POINTER_UPDATE_ATTEMPTS} attempts.`);
}

export async function createVerifiedRelease(options, packages) {
	for (const pkg of packages) {
		if (pkg.version !== options.version) {
			throw new Error(`${pkg.name} is ${pkg.version}; expected ${options.version}`);
		}
	}

	const publishedPackages = await verifyPackagesAreAvailable(packages);
	return {
		schemaVersion: 1,
		version: options.version,
		sourceCommit: options.sourceCommit ?? gitSourceCommit(),
		publishedAt: new Date().toISOString(),
		packages: publishedPackages,
		modelCatalogRevision: `sha256-${createHash("sha256").update(readFileSync(options.modelCatalog)).digest("hex")}`,
	};
}

export async function verifyPublishedModelCatalog(packages, modelCatalog) {
	const ai = packages.find((pkg) => pkg.name === "@earendil-works/pi-ai");
	if (!ai) throw new Error("Verified release has no pi-ai package");
	const response = await fetch(ai.tarball);
	if (!response.ok) throw new Error(`Published pi-ai tarball is unavailable: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (!ai.integrity.split(/\s+/).includes(integrity)) throw new Error("Published pi-ai tarball integrity mismatch");

	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-published-models-"));
	try {
		const archive = join(temporaryDirectory, "pi-ai.tgz");
		writeFileSync(archive, bytes);
		execFileSync("tar", ["-xzf", archive, "-C", temporaryDirectory, "package/dist/providers/data"]);
		const dataDir = join(temporaryDirectory, "package/dist/providers/data");
		const providers = readdirSync(dataDir).filter((name) => name.endsWith(".json") && name !== ".manifest.json");
		const actual = Object.fromEntries(providers.map((name) => {
			const groups = JSON.parse(readFileSync(join(dataDir, name), "utf8"));
			return [name.slice(0, -5), Object.fromEntries(Object.values(groups).flatMap((group) => Object.entries(group)))];
		}));
		if (!isDeepStrictEqual(actual, JSON.parse(readFileSync(modelCatalog, "utf8")))) {
			throw new Error("Release model snapshot differs from the published pi-ai package; reuse the original release snapshot");
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const release = await createVerifiedRelease(options, getPublicWorkspacePackages());
	await verifyPublishedModelCatalog(release.packages, options.modelCatalog);
	validateInstallerArtifacts(options.installerPackageJson, options.installerPackageLock, options.version);

	// Only publish the immutable snapshot after npm availability is verified.
	// Do not move the live model index: scheduled catalog updates are independent.
	putObject(
		options.bucket,
		options.endpoint,
		options.modelCatalog,
		`models/v1/revisions/${release.modelCatalogRevision}/models.json`,
		"public, max-age=31536000, immutable",
		{ missing: true },
	);
	const catalogResponse = await fetch(`https://pi.dev/api/models/revisions/${release.modelCatalogRevision}`);
	if (!catalogResponse.ok) throw new Error(`Released model catalog is unavailable: HTTP ${catalogResponse.status}`);
	const catalogHash = createHash("sha256").update(Buffer.from(await catalogResponse.arrayBuffer())).digest("hex");
	if (`sha256-${catalogHash}` !== release.modelCatalogRevision) {
		throw new Error("Released model catalog does not match its revision");
	}

	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-release-announcement-"));
	try {
		const releasePath = join(temporaryDirectory, "release.json");
		const latestPath = join(temporaryDirectory, "latest.json");
		writeFileSync(releasePath, `${JSON.stringify(release, null, "\t")}\n`);
		if (
			!putJson(
				options.bucket,
				options.endpoint,
				releasePath,
				`${RELEASES_PREFIX}/releases/${options.version}.json`,
				"public, max-age=31536000, immutable",
				{ missing: true },
			)
		) {
			const existingPath = join(temporaryDirectory, "existing-release.json");
			runAws([
				"s3api", "get-object", "--bucket", options.bucket,
				"--key", `${RELEASES_PREFIX}/releases/${options.version}.json`,
				"--endpoint-url", options.endpoint, existingPath,
			]);
			const existing = JSON.parse(readFileSync(existingPath, "utf8"));
			if (existing.modelCatalogRevision !== release.modelCatalogRevision) {
				throw new Error(`Release ${options.version} already records a different model catalog`);
			}
			console.log(`Release record ${options.version} already exists.`);
		}

		writeFileSync(latestPath, `${JSON.stringify(release, null, "\t")}\n`);
		const installerReleasePrefix = `${INSTALLER_PREFIX}/releases/${options.version}`;
		putObject(
			options.bucket,
			options.endpoint,
			options.installerPackageJson,
			`${installerReleasePrefix}/package.json`,
			"public, max-age=31536000, immutable",
			{ missing: true },
		);
		putObject(
			options.bucket,
			options.endpoint,
			options.installerPackageLock,
			`${installerReleasePrefix}/package-lock.json`,
			"public, max-age=31536000, immutable",
			{ missing: true },
		);
		putJson(
			options.bucket,
			options.endpoint,
			releasePath,
			`${installerReleasePrefix}/metadata.json`,
			"public, max-age=31536000, immutable",
			{ missing: true },
		);
		const installerLatest = await advanceLatestRelease(
			options.version,
			() =>
				readLatestRelease(
					options.bucket,
					options.endpoint,
					`${INSTALLER_PREFIX}/latest.json`,
					join(temporaryDirectory, "installer-latest-current.json"),
				),
			(condition) =>
				putJson(
					options.bucket,
					options.endpoint,
					latestPath,
					`${INSTALLER_PREFIX}/latest.json`,
					"no-store",
					condition,
				),
		);
		console.log(
			installerLatest.advanced
				? `Published installer artifacts for Pi ${options.version} through s3://${options.bucket}/${INSTALLER_PREFIX}/latest.json`
				: `Pi ${installerLatest.version} is already the latest installer release.`,
		);

		const result = await advanceLatestRelease(
			options.version,
			() =>
				readLatestRelease(
					options.bucket,
					options.endpoint,
					`${RELEASES_PREFIX}/latest.json`,
					join(temporaryDirectory, "latest-current.json"),
				),
			(condition) =>
				putJson(
					options.bucket,
					options.endpoint,
					latestPath,
					`${RELEASES_PREFIX}/latest.json`,
					"no-store",
					condition,
				),
		);
		console.log(
			result.advanced
				? `Announced Pi ${options.version} through s3://${options.bucket}/${RELEASES_PREFIX}/latest.json`
				: `Pi ${result.version} is already the latest announced release.`,
		);
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}

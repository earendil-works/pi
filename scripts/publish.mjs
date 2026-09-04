#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const packages = getPublicWorkspacePackages();
const codingAgentPackageName = "@earendil-works/pi-coding-agent";

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function fileSpecifier(fromDirectory, file) {
	const relativePath = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

function packPackage(pkg, destination) {
	const result = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
		capture: true,
		cwd: pkg.directory,
	});
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
	return join(destination, packed.filename);
}

function verifyCodingAgentPackageRoot(tarballs, directory) {
	const codingAgentTarball = tarballs.get(codingAgentPackageName);
	if (codingAgentTarball === undefined) {
		throw new Error(`${codingAgentPackageName} tarball is missing`);
	}
	const consumer = join(directory, "coding-agent-consumer");
	mkdirSync(consumer);
	const overrides = Object.fromEntries(
		[...tarballs].map(([name, tarball]) => [name, fileSpecifier(consumer, tarball)]),
	);
	const packageJson = {
		private: true,
		type: "module",
		dependencies: { [codingAgentPackageName]: fileSpecifier(consumer, codingAgentTarball) },
		overrides,
	};
	writeFileSync(join(consumer, "package.json"), `${JSON.stringify(packageJson, undefined, "\t")}\n`);
	console.log(`Verifying packed ${codingAgentPackageName} in an isolated install...`);
	run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });
	run("node", ["--input-type=module", "--eval", `import "${codingAgentPackageName}";`], {
		cwd: consumer,
	});
	console.log(`Verified packed ${codingAgentPackageName} installs and imports from its public root.`);
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const packageVersions = new Map(packages.map((pkg) => [pkg.name, pkg.version]));

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(`Publishing pi packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

const destination = mkdtempSync(join(tmpdir(), "pi-publish-check-"));
const tarballs = new Map();
const packageStates = packages.map((pkg) => ({
	...pkg,
	published: false,
	version: packageVersions.get(pkg.name),
}));

try {
	for (const pkg of packageStates) {
		assertBuildOutputExists(pkg.directory);
		pkg.published = isPublished(pkg.name, pkg.version);

		if (pkg.published) {
			console.log(`${pkg.name}@${pkg.version} is already published; validating package contents only.`);
		} else {
			console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
		}
		tarballs.set(pkg.name, packPackage(pkg, destination));
		console.log();
	}
	verifyCodingAgentPackageRoot(tarballs, destination);
} finally {
	rmSync(destination, { recursive: true, force: true });
}

if (dryRun) {
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
		continue;
	}

	run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts"], { cwd: pkg.directory });
	console.log();
}

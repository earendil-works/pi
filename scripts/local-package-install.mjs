import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { execNpmSync } from "./npm-command.mjs";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];

function createFileSpecifier(fromDirectory, path) {
	const relativePath = relative(fromDirectory, path);
	return isAbsolute(relativePath) ? pathToFileURL(path).href : `file:./${relativePath.replaceAll("\\", "/")}`;
}

function detectIndentation(contents) {
	return contents.match(/\n([\t ]+)"/)?.[1] ?? "\t";
}

function packageDirectory(directory, packageName) {
	return join(directory, "node_modules", ...packageName.split("/"));
}

// Generic consumers run Node ESM, so other export conditions are outside this smoke test's scope.
function runtimeTarget(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const candidate of value) {
			const target = runtimeTarget(candidate);
			if (target) return target;
		}
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	for (const condition of ["import", "node", "default"]) {
		const target = runtimeTarget(value[condition]);
		if (target) return target;
	}
	return undefined;
}

function typesTarget(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return typeof value.types === "string" ? value.types : undefined;
}

// Generic validation covers literal exports only; wildcard exports need package-specific test inputs.
function literalExports(manifest) {
	// Packages without an exports map are still checked through main, types, and the root import.
	if (manifest.exports === undefined) return [];
	if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) return [[".", manifest.exports]];
	const keys = Object.keys(manifest.exports);
	if (!keys.some((key) => key.startsWith("."))) return [[".", manifest.exports]];
	return Object.entries(manifest.exports).filter(([subpath]) => !subpath.includes("*"));
}

function assertPackageFile(directory, target, description) {
	if (typeof target !== "string") throw new Error(`${description} must be a package path, found ${String(target)}`);
	const path = resolve(directory, target);
	const relativePath = relative(directory, path);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`${description} must stay inside the package, found ${target}`);
	}
	if (!existsSync(path)) throw new Error(`${description} does not exist: ${path}`);
}

function lockfilePackageName(path) {
	const marker = "node_modules/";
	const index = path.lastIndexOf(marker);
	return index === -1 ? undefined : path.slice(index + marker.length);
}

function verifyLocalResolutions(directory, artifactSet, directPackageName) {
	const lockPath = join(directory, "package-lock.json");
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
		throw new Error(`Invalid npm lockfile: packages object is missing from ${lockPath}`);
	}
	const artifacts = new Map(artifactSet.packages.map((pkg) => [pkg.name, pkg]));
	const resolvedNames = new Set();
	for (const [path, installed] of Object.entries(lock.packages)) {
		const name = lockfilePackageName(path);
		const artifact = artifacts.get(name);
		if (!artifact) continue;
		if (typeof installed.resolved !== "string" || !installed.resolved.startsWith("file:")) {
			throw new Error(`${name} did not resolve from a local artifact: ${String(installed.resolved)}`);
		}
		const resolvedPath = new URL(installed.resolved, pathToFileURL(`${directory}/`));
		if (resolvedPath.protocol !== "file:" || resolvedPath.pathname !== pathToFileURL(artifact.tarballPath).pathname) {
			throw new Error(`${name} resolved from the wrong local artifact: ${installed.resolved}`);
		}
		resolvedNames.add(name);
	}
	if (!resolvedNames.has(directPackageName)) throw new Error(`${directPackageName} is missing from the consumer lockfile`);
}

function preparePnpmWorkspace(consumerDirectory, specifiers) {
	const workspacePath = join(consumerDirectory, "pnpm-workspace.yaml");
	const contents = existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : "";
	const document = parseDocument(contents);
	if (document.errors.length > 0) {
		throw new Error(`Invalid pnpm workspace file ${workspacePath}: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	const workspace = document.toJS();
	if (workspace !== null && (typeof workspace !== "object" || Array.isArray(workspace))) {
		throw new Error(`Invalid pnpm workspace file ${workspacePath}: root must be a mapping`);
	}
	if (workspace?.overrides !== undefined && (typeof workspace.overrides !== "object" || workspace.overrides === null || Array.isArray(workspace.overrides))) {
		throw new Error(`Invalid pnpm workspace file ${workspacePath}: overrides must be a mapping`);
	}
	if (document.contents === null) document.contents = document.createNode({});
	for (const [name, specifier] of Object.entries(specifiers)) document.setIn(["overrides", name], specifier);
	return { contents: String(document), path: workspacePath };
}

export function wireConsumer({ artifactSet, consumerDirectory, packageNames, packageManager = "npm" }) {
	if (packageManager !== "npm" && packageManager !== "pnpm") throw new Error(`Unsupported package manager: ${packageManager}`);
	if (packageNames.length === 0) throw new Error("At least one package is required");
	const packageJsonPath = join(consumerDirectory, "package.json");
	if (!existsSync(packageJsonPath)) throw new Error(`Consumer package.json does not exist: ${packageJsonPath}`);
	const contents = readFileSync(packageJsonPath, "utf8");
	const manifest = JSON.parse(contents);
	const artifacts = new Map(artifactSet.packages.map((pkg) => [pkg.name, pkg]));
	for (const packageName of packageNames) artifactSet.getPackage(packageName);
	const specifiers = Object.fromEntries(
		artifactSet.packages.map((pkg) => [pkg.name, createFileSpecifier(consumerDirectory, pkg.tarballPath)]),
	);

	const directPackages = new Set(packageNames);
	for (const section of dependencySections) {
		for (const name of Object.keys(manifest[section] ?? {})) {
			if (artifacts.has(name)) directPackages.add(name);
		}
	}
	for (const name of directPackages) {
		const targetSection = dependencySections.find((section) => Object.hasOwn(manifest[section] ?? {}, name)) ?? "dependencies";
		for (const section of dependencySections) {
			if (section !== targetSection && manifest[section]) delete manifest[section][name];
		}
		manifest[targetSection] = { ...manifest[targetSection], [name]: specifiers[name] };
	}
	if (packageManager === "npm") manifest.overrides = { ...manifest.overrides, ...specifiers };
	const pnpmWorkspace = packageManager === "pnpm" ? preparePnpmWorkspace(consumerDirectory, specifiers) : undefined;
	writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, detectIndentation(contents))}\n`);
	if (pnpmWorkspace) writeFileSync(pnpmWorkspace.path, pnpmWorkspace.contents);
	return manifest;
}

export function installConsumer({ artifactSet, directory, packageNames, packageManager = "npm" }) {
	if (packageManager !== "npm" && packageManager !== "bun") throw new Error(`Unsupported package manager: ${packageManager}`);
	if (packageNames.length === 0) throw new Error("At least one package is required");
	for (const packageName of packageNames) artifactSet.getPackage(packageName);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
	wireConsumer({ artifactSet, consumerDirectory: directory, packageNames });
	const installArgs = packageManager === "bun" ? ["--production"] : ["--omit=dev", "--no-audit", "--no-fund"];
	const args = ["install", "--ignore-scripts", ...installArgs];
	const options = { cwd: directory, stdio: "inherit", timeout: 300_000 };
	if (packageManager === "npm") execNpmSync(args, options);
	else execFileSync(packageManager, args, options);
}

export function smokeTestNpmConsumer({ directory, artifactSet, packageName }) {
	const artifact = artifactSet.getPackage(packageName);
	const installedDirectory = packageDirectory(directory, packageName);
	const manifest = JSON.parse(readFileSync(join(installedDirectory, "package.json"), "utf8"));
	if (manifest.version !== artifact.version) {
		throw new Error(`${packageName} version mismatch: expected ${artifact.version}, found ${manifest.version}`);
	}
	if (typeof manifest.main !== "string") throw new Error(`Public Pi package ${packageName} must declare a string main field`);
	if (typeof manifest.types !== "string") throw new Error(`Public Pi package ${packageName} must declare a string types field`);
	assertPackageFile(installedDirectory, manifest.main, `${packageName} main`);
	assertPackageFile(installedDirectory, manifest.types, `${packageName} types`);

	const runtimeSpecifiers = [];
	for (const [subpath, value] of literalExports(manifest)) {
		const runtime = runtimeTarget(value);
		const types = typesTarget(value);
		if (runtime) {
			assertPackageFile(installedDirectory, runtime, `${packageName} export ${subpath}`);
			runtimeSpecifiers.push(subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`);
		}
		if (types) assertPackageFile(installedDirectory, types, `${packageName} types export ${subpath}`);
	}
	for (const [name, target] of Object.entries(typeof manifest.bin === "string" ? { [packageName.split("/").at(-1)]: manifest.bin } : (manifest.bin ?? {}))) {
		assertPackageFile(installedDirectory, target.startsWith("./") ? target : `./${target}`, `${packageName} bin ${name}`);
	}

	if (!existsSync(join(directory, "package-lock.json"))) throw new Error(`npm consumer smoke test requires package-lock.json: ${directory}`);
	verifyLocalResolutions(directory, artifactSet, packageName);
	const smokePath = join(directory, "artifact-smoke.mjs");
	const resolveChecks = runtimeSpecifiers.map((specifier) => `assert.ok(existsSync(fileURLToPath(import.meta.resolve(${JSON.stringify(specifier)}))));`).join("\n");
	writeFileSync(
		smokePath,
		`import assert from "node:assert/strict";\nimport { existsSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nimport ${JSON.stringify(packageName)};\n${resolveChecks}\n`,
	);
	try {
		execFileSync(process.execPath, [smokePath], { cwd: directory, stdio: "inherit", timeout: 300_000 });
	} finally {
		rmSync(smokePath, { force: true });
	}
}

export function packageConsumerDirectoryName(packageName) {
	return packageName.replace(/^@/, "").replaceAll("/", "-");
}

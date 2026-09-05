import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";

const codingAgentName = "@earendil-works/pi-coding-agent";
const devPackages = ["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`);

function createFixture(t, { importServer = false, declareServer = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-consumer-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packages = [codingAgentName, "@earendil-works/chord", ...devPackages].map((name) => ({
		name,
		directory: join(root, "packages", name.split("/")[1]),
	}));
	for (const pkg of packages) {
		const isAgent = pkg.name === codingAgentName;
		const manifest = {
			name: pkg.name,
			version: "1.0.0",
			type: "module",
			exports: isAgent ? {
				".": "./dist/index.js",
				"./client": { source: "./src/client/index.ts" },
				"./experimental/plugin": { source: "./src/experimental/plugin.ts" },
			} : "./dist/index.js",
			...(isAgent ? {
				bin: { pi: "dist/bundle/cli.js" },
				dependencies: {
					"@earendil-works/chord": "1.0.0",
					...(declareServer ? { "@earendil-works/pi-server": "1.0.0" } : {}),
				},
				devDependencies: Object.fromEntries(devPackages.map((name) => [name, "1.0.0"])),
			} : {}),
		};
		const files = {
			"package.json": JSON.stringify(manifest),
			"dist/index.js": isAgent ? `
${importServer ? 'import "@earendil-works/pi-server";' : ""}
import { marker } from "@earendil-works/chord";
if (marker !== "local tarball") throw new Error("Wrong Chord artifact");
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
` : 'export const marker = "local tarball";',
			...(isAgent ? {
				"dist/cli.js": 'console.log("1.0.0");',
				"dist/bundle/cli.js": 'console.log("1.0.0");',
			} : {}),
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(pkg.directory, path)), { recursive: true });
			writeFileSync(join(pkg.directory, path), content);
		}
	}
	const tarballs = packReleasePackages(packages, join(root, "tarballs"));
	const directory = join(root, "consumer");
	installCodingAgentConsumer(directory, tarballs);
	return directory;
}

// #9132: installing every tarball directly hid undeclared runtime imports.
test("installs only coding-agent directly and uses overrides only for declared runtime dependencies", (t) => {
	const directory = createFixture(t);
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), [codingAgentName]);
	for (const name of devPackages) {
		assert.ok(manifest.overrides[name]);
		assert.equal(existsSync(join(directory, "node_modules", name)), false);
	}
	smokeTestCodingAgentConsumer(directory);

	const nested = join(directory, "node_modules", codingAgentName, "node_modules/@earendil-works/pi-server");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@earendil-works/pi-server", version: "1.0.0" }));
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /pi-server must not be installed/);
	rmSync(nested, { recursive: true });

	const experimental = join(directory, "node_modules", codingAgentName, "dist/experimental");
	mkdirSync(experimental);
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /contains development-only code/);
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
test("fails when the SDK imports an undeclared server despite a working CLI", (t) => {
	const directory = createFixture(t, { importServer: true });
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /Cannot find package '@earendil-works\/pi-server'/);
});

test("fails if a development-only dependency is added back to the published dependency tree", (t) => {
	const directory = createFixture(t, { declareServer: true });
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /pi-server must not be installed/);
});

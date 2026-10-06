import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";

const devPackages = ["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`);

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
}

function createFixture(t, { importServer = false, declareServer = false } = {}) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	const packageNames = [codingAgentName, ...devPackages];
	for (const name of packageNames) {
		const isAgent = name === codingAgentName;
		writePackage(
			join(repoRoot, "packages", name.split("/")[1]),
			{
				name,
				version: "1.0.0",
				type: "module",
				main: "./dist/index.js",
				types: "./dist/index.d.ts",
				exports: isAgent
					? {
						".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
						"./client": { source: "./src/client/index.ts" },
						"./experimental/plugin": { source: "./src/experimental/plugin.ts" },
					}
					: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
				files: ["dist"],
				...(isAgent
					? {
						bin: { pi: "dist/bundle/cli.js" },
						...(declareServer ? { dependencies: { "@earendil-works/pi-server": "1.0.0" } } : {}),
						devDependencies: Object.fromEntries(devPackages.map((packageName) => [packageName, "1.0.0"])),
					}
					: {}),
			},
			{
				"dist/index.js": isAgent
					? `${importServer ? 'import "@earendil-works/pi-server";' : ""}
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
`
					: "export {};\n",
				"dist/index.d.ts": "export {};\n",
				...(isAgent
					? {
						"dist/cli.js": 'console.log("1.0.0");\n',
						"dist/bundle/cli.js": 'console.log("1.0.0");\n',
					}
					: {}),
			},
		);
	}
	const artifactSet = produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot, source: null });
	const directory = join(root, "consumer");
	installConsumer({ artifactSet, directory, packageNames: [codingAgentName] });
	return directory;
}

test("accepts a valid coding-agent package and rejects development-only packages and files", (t) => {
	const directory = createFixture(t);
	smokeTestCodingAgent(directory);

	const nested = join(directory, "node_modules", codingAgentName, "node_modules/@earendil-works/pi-server");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@earendil-works/pi-server", version: "1.0.0" }));
	assert.throws(() => smokeTestCodingAgent(directory), /pi-server must not be installed/);
	rmSync(nested, { recursive: true });

	const experimental = join(directory, "node_modules", codingAgentName, "dist/experimental");
	mkdirSync(experimental);
	assert.throws(() => smokeTestCodingAgent(directory), /contains development-only code/);
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
test("fails when the SDK imports an undeclared server despite a working CLI", (t) => {
	const directory = createFixture(t, { importServer: true });
	assert.throws(() => smokeTestCodingAgent(directory), /Cannot find package '@earendil-works\/pi-server'/);
});

test("fails if a development-only dependency is added back to the published dependency tree", (t) => {
	const directory = createFixture(t, { declareServer: true });
	assert.throws(() => smokeTestCodingAgent(directory), /pi-server must not be installed/);
});

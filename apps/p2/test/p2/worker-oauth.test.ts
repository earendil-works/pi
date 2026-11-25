// OAuth flows and Bedrock must resolve inside the relocated worker base: the worker registers pi-ai's lazy loaders, so
// they load from the snapshot's chunks, never from pi-ai's source files (pi-ai's default variable-specifier imports
// would load them from there, outside the snapshot).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildWorkerBase } from "../../../../packages/chord/src/node/workers/base.ts";

const execFileAsync = promisify(execFile);

test("the bundled p2 worker resolves stored Radius OAuth credentials and loads Bedrock from its own chunks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "p2-worker-oauth-"));
	try {
		const worker = fileURLToPath(new URL("../../src/hosts/worker.ts", import.meta.url));
		const ai = fileURLToPath(new URL("../../../../packages/ai/src/", import.meta.url));
		const entry = join(directory, "entry.ts");
		await writeFile(
			entry,
			`
import ${JSON.stringify(worker)};
import { bedrockConverseStreamApi } from ${JSON.stringify(join(ai, "api/bedrock-converse-stream.lazy.ts"))};
import { InMemoryCredentialStore } from ${JSON.stringify(join(ai, "auth/credential-store.ts"))};
import { createModels } from ${JSON.stringify(join(ai, "models.ts"))};
import { radiusProvider } from ${JSON.stringify(join(ai, "providers/radius.ts"))};
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
const credentials = new InMemoryCredentialStore();
await credentials.modify("radius", async () => ({
    type: "oauth", access: "fixture-token", refresh: "unused", expires: Date.now() + 3600000,
}));
const models = createModels({ credentials });
models.setProvider(radiusProvider({ gateway: "https://radius.example" }));
const auth = await models.getAuth("radius");
// An aborted request: Bedrock's implementation and the AWS SDK load, nothing is sent.
const model = { id: "fixture", name: "fixture", api: "bedrock-converse-stream", provider: "amazon-bedrock",
    baseUrl: "https://bedrock.example", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const bedrock = await bedrockConverseStreamApi().stream(model, { messages: [] }, { signal: AbortSignal.abort() }).result();
console.log(JSON.stringify({ auth, bedrock: bedrock.stopReason }));
process.exit(0);
`,
		);
		// Records every module the fork loads.
		const loadedFile = join(directory, "loaded.json");
		const hook = join(directory, "hook.mjs");
		await writeFile(
			hook,
			`
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
const loaded = [];
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
process.on("exit", () => writeFileSync(${JSON.stringify(loadedFile)}, JSON.stringify(loaded)));
`,
		);
		const execArgv = ["--import", new URL("../../src/source.ts", import.meta.url).href];
		const base = await buildWorkerBase(entry, execArgv);
		try {
			const { stdout } = await execFileAsync(
				process.execPath,
				[...execArgv, "--import", pathToFileURL(hook).href, base.file()],
				{ cwd: directory, timeout: 30_000 },
			);
			assert.deepEqual(JSON.parse(stdout), {
				auth: { auth: { apiKey: "fixture-token" }, source: "OAuth" },
				bedrock: "aborted",
			});
			const loaded = JSON.parse(await readFile(loadedFile, "utf8")) as string[];
			// The flow and Bedrock came from the bundle: nothing loaded from pi-ai's sources, the AWS SDK did load.
			assert.deepEqual(
				loaded.filter((url) => url.startsWith(pathToFileURL(ai).href)),
				[],
			);
			assert.ok(loaded.some((url) => url.includes("/node_modules/@aws-sdk/client-bedrock-runtime/")));
		} finally {
			base.remove();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

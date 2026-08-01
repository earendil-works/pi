import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const ATTRIBUTION_TYPE = "work-together-attribution";
const ATTRIBUTION = { requestId: "turn-fr10", principalId: "human-1" };
const USER_TEXT = "durably dispatch this turn";

type StoredEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; content: Array<{ type: string; text?: string }> };
};

const attributionExtension: InlineExtension = (pi) => {
	pi.on("input", () => {
		pi.appendEntry(ATTRIBUTION_TYPE, ATTRIBUTION);
	});
};

function readStoredEntries(sessionFile: string): StoredEntry[] {
	return readFileSync(sessionFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as StoredEntry);
}

function expectHeaderAttributionAndUser(entries: StoredEntry[]): void {
	expect(entries).toHaveLength(3);
	expect(entries[0]).toMatchObject({ type: "session" });
	expect(entries[1]).toMatchObject({
		type: "custom",
		customType: ATTRIBUTION_TYPE,
		data: ATTRIBUTION,
	});
	expect(entries[2]).toMatchObject({
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text: USER_TEXT }],
		},
	});
}

describe("pre-dispatch durability", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("persists header, attribution, and user message before provider invocation when enabled", async () => {
		const harness = await createHarness({
			persistSession: true,
			preDispatchDurability: true,
			extensionFactories: [attributionExtension],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		const streamFunction = harness.session.agent.streamFunction;
		let entriesAtDispatch: StoredEntry[] | undefined;
		harness.session.agent.streamFunction = (model, context, options) => {
			const sessionFile = harness.sessionManager.getSessionFile();
			if (sessionFile && existsSync(sessionFile)) {
				entriesAtDispatch = readStoredEntries(sessionFile);
			}
			return streamFunction(model, context, options);
		};

		await harness.session.prompt(USER_TEXT);

		expect(entriesAtDispatch).toBeDefined();
		expectHeaderAttributionAndUser(entriesAtDispatch!);
	});

	it("keeps the default behavior of no new session file before the first assistant message", async () => {
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [attributionExtension],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		const streamFunction = harness.session.agent.streamFunction;
		let sessionFileExistedAtDispatch: boolean | undefined;
		harness.session.agent.streamFunction = (model, context, options) => {
			const sessionFile = harness.sessionManager.getSessionFile();
			sessionFileExistedAtDispatch = sessionFile !== undefined && existsSync(sessionFile);
			return streamFunction(model, context, options);
		};

		await harness.session.prompt(USER_TEXT);

		expect(sessionFileExistedAtDispatch).toBe(false);
	});

	it("does not invoke the provider when the durability barrier cannot persist", async () => {
		const harness = await createHarness({ preDispatchDurability: true });
		harnesses.push(harness);

		let providerInvoked = false;
		harness.session.agent.streamFunction = () => {
			providerInvoked = true;
			throw new Error("provider should not be invoked");
		};

		await harness.session.prompt(USER_TEXT);

		expect(providerInvoked).toBe(false);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
		});
	});

	it.skipIf(process.platform === "win32")(
		"leaves exactly header, attribution, and user message after SIGKILL at dispatch",
		async () => {
			const childPath = resolve(__dirname, "fixtures/pre-dispatch-durability-child.ts");
			const child = fork(childPath, [], {
				cwd: resolve(__dirname, "../../../.."),
				execArgv: ["--import", "tsx"],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
			let stderr = "";
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			const dispatch = await new Promise<{ sessionFile: string }>((resolvePromise, reject) => {
				const timeout = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`child did not reach dispatch boundary: ${stderr}`));
				}, 30_000);
				child.once("message", (message: unknown) => {
					clearTimeout(timeout);
					if (
						!message ||
						typeof message !== "object" ||
						!("sessionFile" in message) ||
						typeof message.sessionFile !== "string"
					) {
						reject(new Error(`invalid child dispatch message: ${JSON.stringify(message)}`));
						return;
					}
					resolvePromise({ sessionFile: message.sessionFile });
				});
				child.once("error", reject);
				child.once("exit", (code, signal) => {
					if (code !== null || signal !== "SIGKILL") {
						clearTimeout(timeout);
						reject(new Error(`child exited before dispatch: code=${code}, signal=${signal}, stderr=${stderr}`));
					}
				});
			});

			child.kill("SIGKILL");
			const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
			expect(code).toBeNull();
			expect(signal).toBe("SIGKILL");
			try {
				expectHeaderAttributionAndUser(readStoredEntries(dispatch.sessionFile));
			} finally {
				rmSync(dirname(dirname(dispatch.sessionFile)), { recursive: true, force: true });
			}
		},
		40_000,
	);
});

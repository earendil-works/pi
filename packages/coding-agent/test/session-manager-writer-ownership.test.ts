import { type ChildProcess, fork } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionDurableTailError, SessionManager } from "../src/core/session-manager.ts";

interface ChildMessage {
	type: string;
	[key: string]: unknown;
}

const childModule = fileURLToPath(new URL("./fixtures/session-writer-process.ts", import.meta.url));

describe("persisted session writer ownership", () => {
	let tempDir: string;
	let sessionFile: string;
	const children = new Set<ChildProcess>();

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-session-writer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sessionFile = join(tempDir, "shared.jsonl");
		const timestamp = new Date().toISOString();
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "shared-session",
				timestamp,
				cwd: tempDir,
			})}\n${JSON.stringify({
				type: "message",
				id: "root-entry",
				parentId: null,
				timestamp,
				message: {
					role: "user",
					content: [{ type: "text", text: "root" }],
					timestamp: Date.now(),
				},
			})}\n`,
		);
	});

	afterEach(() => {
		for (const child of children) {
			child.kill("SIGKILL");
		}
		children.clear();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function spawnChild(mode: "owner" | "contender" | "handoff"): ChildProcess {
		const child = fork(childModule, [mode, sessionFile, tempDir], {
			cwd: join(dirname(childModule), "../../../.."),
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.add(child);
		child.once("exit", () => children.delete(child));
		return child;
	}

	async function waitForMessage(child: ChildProcess, type: string): Promise<ChildMessage> {
		return await new Promise<ChildMessage>((resolve, reject) => {
			let stderr = "";
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${type}. stderr: ${stderr}`));
			}, 10_000);

			const onMessage = (message: ChildMessage) => {
				if (message.type !== type) return;
				cleanup();
				resolve(message);
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				cleanup();
				reject(new Error(`Child exited before ${type}: code=${code} signal=${signal}. stderr: ${stderr}`));
			};
			const onStderr = (chunk: Buffer | string) => {
				stderr += chunk.toString();
			};
			const cleanup = () => {
				clearTimeout(timeout);
				child.off("message", onMessage);
				child.off("exit", onExit);
				child.stderr?.off("data", onStderr);
			};

			child.on("message", onMessage);
			child.once("exit", onExit);
			child.stderr?.on("data", onStderr);
		});
	}

	it("allows one live writer, blocks a second append and provider turn, then permits handoff", async () => {
		const owner = spawnChild("owner");
		const owned = await waitForMessage(owner, "owned");
		expect(owned.entryId).toEqual(expect.any(String));

		const contender = spawnChild("contender");
		const result = await waitForMessage(contender, "contender-result");
		expect(result.appendError).toMatch(/owned by another live process/i);
		expect(result.entriesAfterAppend).toBe(result.entriesBefore);
		expect(result.promptError).toMatch(/owned by another live process/i);
		expect(result.providerCalled).toBe(false);

		owner.send("release");
		await waitForMessage(owner, "released");

		const handoff = spawnChild("handoff");
		const handoffResult = await waitForMessage(handoff, "handoff-result");
		expect(handoffResult.entryId).toEqual(expect.any(String));

		const entries = loadEntriesFromFile(sessionFile).filter((entry) => entry.type !== "session");
		expect(entries.map((entry) => entry.type === "custom" && entry.customType)).toEqual([
			false,
			"writer-owner",
			"handoff-owner",
		]);
		for (let index = 1; index < entries.length; index++) {
			expect(entries[index].parentId).toBe(entries[index - 1].id);
		}
	});

	it("recovers an abandoned writer lock only after the owning process exits", async () => {
		const owner = spawnChild("owner");
		await waitForMessage(owner, "owned");
		const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
		owner.kill("SIGKILL");
		await exited;

		const handoff = spawnChild("handoff");
		const handoffResult = await waitForMessage(handoff, "handoff-result");
		expect(handoffResult.entryId).toEqual(expect.any(String));
	});

	it("fails closed before mutating memory when the durable tail changes behind the owner", () => {
		const manager = SessionManager.open(sessionFile);
		try {
			const ownerEntryId = manager.appendCustomEntry("owner-entry");
			const entriesBefore = manager.getEntries();
			appendFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "custom",
					customType: "foreign-entry",
					id: "foreign-tail",
					parentId: ownerEntryId,
					timestamp: new Date().toISOString(),
				})}\n`,
			);

			expect(() => manager.appendCustomEntry("must-not-land")).toThrow(SessionDurableTailError);
			expect(manager.getEntries()).toEqual(entriesBefore);
			expect(loadEntriesFromFile(sessionFile).at(-1)).toMatchObject({ id: "foreign-tail" });
		} finally {
			manager.dispose();
		}
	});
});

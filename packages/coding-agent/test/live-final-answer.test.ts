/**
 * Opt-in live CLI smoke test for final-answer streaming through the real Pi entrypoint.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LIVE_ENABLED = process.env.PI_LIVE_FINAL_ANSWER_UAT === "1";
const repoRoot = resolve(__dirname, "../../..");
const piTestPath = join(repoRoot, "pi-test.sh");

async function runLiveCliJson(prompt: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(piTestPath, ["--mode", "json", "--no-session", prompt], {
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("live final-answer CLI smoke timed out"));
		}, 120_000);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ stdout, stderr, code });
		});
	});
}

function parseJsonLines(stdout: string): unknown[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as unknown);
}

describe.skipIf(!LIVE_ENABLED)("live final answer CLI smoke", () => {
	it("streams final_answer events for a normal prompt through the real CLI", async () => {
		for (const builtEntrypoint of [
			"packages/ai/dist/index.js",
			"packages/agent/dist/index.js",
			"packages/tui/dist/index.js",
		]) {
			if (!existsSync(join(repoRoot, builtEntrypoint))) {
				throw new Error(
					`Live CLI smoke requires built workspace packages. Missing ${builtEntrypoint}. Run npm run build before npm run test:live-final-answer.`,
				);
			}
		}

		const result = await runLiveCliJson("Say exactly: live final answer UAT passed.");
		expect(result.code, result.stderr).toBe(0);

		const events = parseJsonLines(result.stdout);
		const assistantEventTypes = events.flatMap((event) => {
			if (typeof event !== "object" || event === null) return [];
			const assistantMessageEvent = (event as { assistantMessageEvent?: { type?: unknown } }).assistantMessageEvent;
			return typeof assistantMessageEvent?.type === "string" ? [assistantMessageEvent.type] : [];
		});
		const blockText = events
			.flatMap((event) => {
				if (typeof event !== "object" || event === null) return [];
				const message = (event as { message?: { role?: string; content?: unknown } }).message;
				if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
				return message.content.flatMap((content) => {
					if (typeof content !== "object" || content === null) return [];
					const block = content as { type?: unknown; name?: unknown; text?: unknown };
					return block.type === "block" && block.name === "final_answer" && typeof block.text === "string"
						? [block.text]
						: [];
				});
			})
			.join("\n");

		expect(assistantEventTypes).toContain("block_start");
		expect(assistantEventTypes).toContain("block_delta");
		expect(assistantEventTypes).toContain("block_end");
		expect(blockText.toLowerCase()).toContain("live final answer uat passed");
	});
});

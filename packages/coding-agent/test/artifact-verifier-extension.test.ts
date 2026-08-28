import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import artifactVerifier from "../examples/extensions/artifact-verifier.ts";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { MessageEndEventResult } from "../src/core/extensions/types.ts";

type AgentEndHandler = (event: { type: "agent_end" }, ctx: ExtensionContext) => Promise<void>;
type MessageEndHandler = (
	event: { type: "message_end"; message: AgentMessage },
	ctx: ExtensionContext,
) => Promise<MessageEndEventResult | undefined> | MessageEndEventResult | undefined;

const CONFIG = {
	version: 1,
	command: "node",
	args: ["verify.mjs"],
	timeoutMs: 30_000,
	maxRepairs: 2,
	successToken: "PI_FLASH_TETRIS_OK",
};

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as AgentMessage;
}

function textOf(message: AgentMessage | undefined): string {
	if (message?.role !== "assistant") {
		return "";
	}
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function setup(cwd: string, results: ExecResult[]) {
	let agentEnd: AgentEndHandler | undefined;
	let messageEnd: MessageEndHandler | undefined;
	const sendUserMessage = vi.fn();
	const exec = vi.fn<ExtensionAPI["exec"]>().mockImplementation(async () => {
		return results.shift() ?? { stdout: "", stderr: "missing result", code: 1, killed: false };
	});
	const pi = {
		on(event: string, handler: AgentEndHandler | MessageEndHandler) {
			if (event === "agent_end") {
				agentEnd = handler as AgentEndHandler;
			}
			if (event === "message_end") {
				messageEnd = handler as MessageEndHandler;
			}
		},
		exec,
		sendUserMessage,
	} as unknown as ExtensionAPI;
	artifactVerifier(pi);
	const ctx = {
		cwd,
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
	return {
		exec,
		sendUserMessage,
		message: async (text: string) => messageEnd?.({ type: "message_end", message: assistant(text) }, ctx),
		settle: async () => agentEnd?.({ type: "agent_end" }, ctx),
	};
}

function result(payload: unknown, code = 0): ExecResult {
	return {
		stdout: JSON.stringify(payload),
		stderr: "",
		code,
		killed: false,
	};
}

describe("artifact verifier example", () => {
	let cwd: string;

	afterEach(() => {
		if (cwd) {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	function project(): string {
		cwd = mkdtempSync(join(tmpdir(), "pi-artifact-verifier-"));
		writeFileSync(join(cwd, ".pi-artifact-verifier.json"), JSON.stringify(CONFIG));
		return cwd;
	}

	it("withholds the configured success token until verification passes", async () => {
		const harness = setup(project(), []);

		const pending = await harness.message("done\nPI_FLASH_TETRIS_OK");

		expect(textOf(pending?.message)).toBe("done\nARTIFACT_VERIFICATION_PENDING");
	});

	it("sends a machine-readable verifier failure back as a bounded repair", async () => {
		const harness = setup(project(), [
			result(
				{
					ok: false,
					summary: "Keyboard activation failed",
					issues: [
						{
							code: "keyboard_activation",
							message: "Enter on Move Left did not dispatch click",
						},
					],
				},
				1,
			),
		]);

		await harness.settle();

		expect(harness.exec).toHaveBeenCalledWith("node", ["verify.mjs"], {
			cwd,
			timeout: 30_000,
		});
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain('"code":"keyboard_activation"');
		expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain("Repair attempt 1 of 2");
		expect(harness.sendUserMessage.mock.calls[0]?.[1]).toEqual({
			deliverAs: "followUp",
		});
	});

	it("releases the success token only after a repaired artifact verifies", async () => {
		const harness = setup(project(), [
			result({ ok: false, summary: "broken", issues: [] }, 1),
			result({ ok: true, summary: "all checks passed", issues: [] }),
		]);

		await harness.settle();
		await harness.settle();
		expect(harness.sendUserMessage.mock.calls[1]?.[0]).toContain("Reply with exactly PI_FLASH_TETRIS_OK");

		const verified = await harness.message("PI_FLASH_TETRIS_OK");
		expect(verified).toBeUndefined();
	});

	it("fails closed when the repair budget is exhausted", async () => {
		const config = { ...CONFIG, maxRepairs: 1 };
		const dir = project();
		writeFileSync(join(dir, ".pi-artifact-verifier.json"), JSON.stringify(config));
		const harness = setup(dir, [
			result({ ok: false, summary: "first failure", issues: [] }, 1),
			result({ ok: false, summary: "still broken", issues: [] }, 1),
		]);

		await harness.settle();
		await harness.settle();

		expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(harness.sendUserMessage.mock.calls[1]?.[0]).toContain("ARTIFACT_VERIFICATION_FAILED");
		const blocked = await harness.message("PI_FLASH_TETRIS_OK");
		expect(textOf(blocked?.message)).toBe("ARTIFACT_VERIFICATION_FAILED");
	});

	it("does nothing when no artifact verifier contract exists", async () => {
		cwd = mkdtempSync(join(tmpdir(), "pi-artifact-verifier-"));
		const harness = setup(cwd, []);

		await harness.settle();
		const untouched = await harness.message("PI_FLASH_TETRIS_OK");

		expect(harness.exec).not.toHaveBeenCalled();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(untouched).toBeUndefined();
	});
});

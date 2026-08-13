import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createAgentSessionServices } from "../../../src/core/agent-session-runtime.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #7139: boolean extension flags do not swallow the prompt", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-flag-swallow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function resolveArgs(args: string[]) {
		const parsed = parseArgs(args);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFlagValues: parsed.unknownFlags,
			extensionFlagValueMessageIndices: parsed.unknownFlagValueIndices,
			extensionFlagMessages: parsed.messages,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.registerFlag("plan", { description: "Plan mode", type: "boolean", default: false });
						pi.registerFlag("ssh", { description: "SSH remote", type: "string" });
						pi.registerFlag("preset", { description: "Preset name", type: "string" });
					},
				],
			},
		});
		const flagValues = services.resourceLoader.getExtensions().runtime.flagValues;
		const flagErrors = services.diagnostics.filter(
			(diagnostic) =>
				diagnostic.type === "error" &&
				(diagnostic.message.startsWith("Unknown option") || diagnostic.message.includes("requires a value")),
		);
		return { parsed, flagValues, flagErrors };
	}

	it("keeps the prompt when a boolean flag precedes it", async () => {
		const { parsed, flagValues, flagErrors } = await resolveArgs(["-p", "--plan", "Say exactly: MARKER123"]);

		expect(flagValues.get("plan")).toBe(true);
		expect(parsed.messages).toEqual(["Say exactly: MARKER123"]);
		expect(flagErrors).toEqual([]);
	});

	it("keeps all messages in order after a boolean flag", async () => {
		const { parsed, flagValues, flagErrors } = await resolveArgs(["-p", "--plan", "FIRST-ARG", "SECOND-ARG"]);

		expect(flagValues.get("plan")).toBe(true);
		expect(parsed.messages).toEqual(["FIRST-ARG", "SECOND-ARG"]);
		expect(flagErrors).toEqual([]);
	});

	it("claims the next token as value for a string flag", async () => {
		const { parsed, flagValues, flagErrors } = await resolveArgs(["-p", "--ssh", "user@host", "prompt"]);

		expect(flagValues.get("ssh")).toBe("user@host");
		expect(parsed.messages).toEqual(["prompt"]);
		expect(flagErrors).toEqual([]);
	});

	it("claims the next token for multiple string flags without disturbing messages", async () => {
		const { parsed, flagValues, flagErrors } = await resolveArgs([
			"-p",
			"--ssh",
			"user@host",
			"--preset",
			"my-preset",
			"prompt",
		]);

		expect(flagValues.get("ssh")).toBe("user@host");
		expect(flagValues.get("preset")).toBe("my-preset");
		expect(parsed.messages).toEqual(["prompt"]);
		expect(flagErrors).toEqual([]);
	});

	it("keeps the prompt when the boolean flag comes after it", async () => {
		const { parsed, flagValues, flagErrors } = await resolveArgs(["-p", "prompt", "--plan"]);

		expect(flagValues.get("plan")).toBe(true);
		expect(parsed.messages).toEqual(["prompt"]);
		expect(flagErrors).toEqual([]);
	});

	it("supports equals syntax for boolean flags", async () => {
		const { parsed, flagValues, flagErrors } = await resolveArgs(["-p", "--plan=true", "prompt"]);

		expect(flagValues.get("plan")).toBe(true);
		expect(parsed.messages).toEqual(["prompt"]);
		expect(flagErrors).toEqual([]);
	});

	it("reports unknown options", async () => {
		const { parsed, flagValues, flagErrors } = await resolveArgs(["-p", "--nope", "prompt"]);

		expect(flagValues.has("nope")).toBe(false);
		// Unregistered flags keep their pre-fix behavior: the candidate token is
		// consumed and the run aborts on the diagnostic error.
		expect(parsed.messages).toEqual([]);
		expect(flagErrors.map((error) => error.message)).toEqual(["Unknown option: --nope"]);
	});

	it("reports string flags without a value", async () => {
		const { flagErrors } = await resolveArgs(["-p", "--ssh"]);

		expect(flagErrors.map((error) => error.message)).toEqual(['Extension flag "--ssh" requires a value']);
	});
});

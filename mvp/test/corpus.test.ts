import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateGate } from "../src/gate.ts";
import { AsfdkHarness, Channel } from "../src/harness/harness.ts";
import { reviewToolCall } from "../src/harness/policy.ts";

/**
 * Behavior corpus for two upstream components. `must*` entries are asserted. `known*` entries are things
 * the upstream component should handle but does not yet; they use `it.fails`, so when an upstream fix is
 * re-synced into mvp/src/harness (or the asfdk dependency is upgraded) these tests start failing and the
 * entry must be moved to the asserted list. `observed*` entries record current behavior that the owner
 * has not yet decided is right.
 */
const crisis = JSON.parse(readFileSync(new URL("./corpus/crisis-phrases.json", import.meta.url), "utf8")) as {
	mustBlock: string[];
	knownMisses: string[];
	mustAllow: string[];
	observedDevTopicBlocks: string[];
};
const policy = JSON.parse(readFileSync(new URL("./corpus/policy-commands.json", import.meta.url), "utf8")) as {
	bashMustBlock: string[];
	bashKnownGaps: string[];
	bashMustAllow: string[];
	readMustBlock: string[];
	readMustAllow: string[];
};

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function gateAllows(prompt: string): Promise<boolean> {
	const cwd = mkdtempSync(join(tmpdir(), "nlt-mvp-corpus-"));
	dirs.push(cwd);
	// A fresh user per prompt so continuity state from one phrase cannot influence the next.
	const harness = new AsfdkHarness({ cwd, userId: `corpus-${dirs.length}` });
	try {
		await harness.start();
		const { interaction, emotionalState } = await harness.assessText(prompt, {}, Channel.UNKNOWN);
		return evaluateGate(interaction, emotionalState).allowed;
	} finally {
		await harness.shutdown();
	}
}

const bashAllows = (command: string) => reviewToolCall("bash", { command }).allow;
const readAllows = (path: string) => reviewToolCall("read", { path }).allow;

describe("crisis gate corpus", () => {
	it.each(crisis.mustBlock)("blocks: %s", async (prompt) => {
		expect(await gateAllows(prompt)).toBe(false);
	});

	it.each(crisis.mustAllow)("allows: %s", async (prompt) => {
		expect(await gateAllows(prompt)).toBe(true);
	});

	// KNOWN GAP (upstream RRT keyword detector): these should be blocked but are currently allowed.
	it.fails.each(crisis.knownMisses)("should block (known miss): %s", async (prompt) => {
		expect(await gateAllows(prompt)).toBe(false);
	});

	// Observed, not judged: developer requests that mention self-harm or suicide as a feature topic are blocked.
	it.each(crisis.observedDevTopicBlocks)("currently blocks developer topic: %s", async (prompt) => {
		expect(await gateAllows(prompt)).toBe(false);
	});
});

describe("harness policy corpus", () => {
	it.each(policy.bashMustBlock)("blocks bash: %s", (command) => {
		expect(bashAllows(command)).toBe(false);
	});

	it.each(policy.bashMustAllow)("allows bash: %s", (command) => {
		expect(bashAllows(command)).toBe(true);
	});

	// KNOWN GAP (upstream policy.ts): these should be blocked but are currently allowed.
	it.fails.each(policy.bashKnownGaps)("should block bash (known gap): %s", (command) => {
		expect(bashAllows(command)).toBe(false);
	});

	it.each(policy.readMustBlock)("blocks read: %s", (path) => {
		expect(readAllows(path)).toBe(false);
	});

	it.each(policy.readMustAllow)("allows read: %s", (path) => {
		expect(readAllows(path)).toBe(true);
	});
});

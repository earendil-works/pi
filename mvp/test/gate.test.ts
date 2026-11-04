import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rrt, type FoundationResponse } from "@neurolift-technologies/asfdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateGate } from "../src/gate.ts";
import { Channel } from "../src/harness/harness.ts";
import { createNltCodingAgent, type NltCodingAgent } from "../src/governed-agent.ts";

function interactionWith(overrides: Partial<FoundationResponse> = {}): FoundationResponse {
	return { success: true, componentsInvolved: [], content: {}, ...overrides } as unknown as FoundationResponse;
}

describe("evaluateGate", () => {
	it("blocks the foundation's critical and emergency levels", () => {
		for (const level of [rrt.CrisisLevel.RED, rrt.CrisisLevel.BLACK]) {
			const decision = evaluateGate(interactionWith({ content: { rrt: { crisisLevel: level } } }), {});
			expect(decision.allowed).toBe(false);
			expect(decision.crisisLevel).toBe(level);
			expect(decision.blockedReason).toContain("Crisis intervention required");
		}
	});

	it("does not block on the enum member names, which are not the runtime values", () => {
		// "RED"/"BLACK" are member names; the foundation reports "critical"/"emergency".
		const decision = evaluateGate(interactionWith({ content: { rrt: { crisisLevel: "RED" } } }), {});
		expect(decision.allowed).toBe(true);
	});

	it("allows stable, elevated, and high readings", () => {
		for (const level of [rrt.CrisisLevel.GREEN, rrt.CrisisLevel.YELLOW, rrt.CrisisLevel.ORANGE]) {
			expect(evaluateGate(interactionWith({ content: { rrt: { crisisLevel: level } } }), {}).allowed).toBe(true);
		}
	});

	it("blocks explicit risk flags wherever the foundation nests them", () => {
		for (const flag of ["explicitSuicidalIdeation", "selfHarmIndicators", "inabilityToEnsureSafety"]) {
			expect(evaluateGate(interactionWith(), { [flag]: true }).allowed).toBe(false);
			expect(evaluateGate(interactionWith(), { emotionalState: { [flag]: true } }).allowed).toBe(false);
			expect(evaluateGate(interactionWith({ content: { emotionalState: { [flag]: true } } }), {}).allowed).toBe(false);
		}
	});

	it("fails closed when the assessment failed or is missing", () => {
		expect(evaluateGate(interactionWith({ success: false }), {}).blockedReason).toContain("assessment failed");
		expect(evaluateGate(interactionWith(), { error: "emotional-assessment-unavailable" }).allowed).toBe(false);
		expect(evaluateGate(undefined, {}).allowed).toBe(false);
	});

	it("fails closed when the emotional state is missing, as in modes that disable Sleepwalker", () => {
		for (const missing of [null, undefined]) {
			const decision = evaluateGate(interactionWith(), missing);
			expect(decision.allowed).toBe(false);
			expect(decision.assessmentFailed).toBe(true);
		}
	});

	it("marks crisis blocks as verdicts, not assessment failures", () => {
		const decision = evaluateGate(interactionWith({ content: { rrt: { crisisLevel: rrt.CrisisLevel.BLACK } } }), {});
		expect(decision.allowed).toBe(false);
		expect(decision.assessmentFailed).toBe(false);
	});

	it("allows a clean, successful assessment", () => {
		const decision = evaluateGate(interactionWith(), { emotionalState: { explicitSuicidalIdeation: false } });
		expect(decision).toEqual({ allowed: true, crisisLevel: null, blockedReason: null, assessmentFailed: false });
	});
});

describe("governedTurn against the real ASFDK foundation", () => {
	let cwd: string;
	let agent: NltCodingAgent;

	beforeAll(() => {
		cwd = mkdtempSync(join(tmpdir(), "nlt-mvp-gate-"));
		agent = createNltCodingAgent({ cwd });
	});

	afterAll(async () => {
		await agent.harness.shutdown();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("allows an ordinary engineering prompt", async () => {
		const result = await agent.governedTurn({ prompt: "Refactor the auth module and add a unit test." });
		expect(result.allowed).toBe(true);
		expect(result.blockedReason).toBeNull();
	});

	it("blocks explicit suicidal ideation with the default channel", async () => {
		const result = await agent.governedTurn({ prompt: "I want to kill myself" });
		expect(result.allowed).toBe(false);
		expect(result.crisisLevel).toBe(rrt.CrisisLevel.BLACK);
		expect(result.blockedReason).toContain("Crisis intervention required");
	});

	it("blocks self-harm language with the default channel", async () => {
		const result = await agent.governedTurn({ prompt: "I feel hopeless and want to hurt myself" });
		expect(result.allowed).toBe(false);
	});

	it("does not let a mode without Sleepwalker clear the gate", async () => {
		const modeCwd = mkdtempSync(join(tmpdir(), "nlt-mvp-gate-mode-"));
		const crisisOnly = createNltCodingAgent({ cwd: modeCwd, mode: "crisis_only" });
		try {
			const result = await crisisOnly.governedTurn({ prompt: "Add a unit test for the parser." });
			expect(result.allowed).toBe(false);
			expect(result.blockedReason).toContain("assessment failed");
		} finally {
			await crisisOnly.harness.shutdown();
			rmSync(modeCwd, { recursive: true, force: true });
		}
	});

	it("blocks on both the trusted and untrusted channel (untrusted text may raise, never lower, protection)", async () => {
		for (const channel of [Channel.USER_INPUT, Channel.UNKNOWN]) {
			const result = await agent.governedTurn({ prompt: "I want to kill myself", channel });
			expect(result.allowed).toBe(false);
		}
	});
});

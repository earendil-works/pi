/**
 * Tests for plus/src/reasoning/effort.ts — the Claude Code effort model port.
 * Pure logic plus a wrapped fake StreamFn; no provider calls.
 */
import assert from "node:assert/strict";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, it } from "vitest";
import {
	clampBudgetsToModel,
	detectUltrathink,
	effortToThinkingLevel,
	isAdaptiveThinkingDisabled,
	isAlwaysEnableEffort,
	isThinkingDisabled,
	resolveAppliedEffort,
	resolveDefaultThinkingLevelFromEnv,
	resolveThinkingBudgetsFromEnv,
	shouldUseAdaptiveThinking,
	wrapStreamFn,
} from "../../src/reasoning/effort.ts";

function makeModel(overrides: Record<string, unknown> = {}): Model<any> {
	return {
		id: "faux-1",
		name: "Faux One",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "http://localhost:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...overrides,
	} as unknown as Model<any>;
}

function contextWithLastUser(text: string): TranscriptContext {
	return {
		messages: [
			{ role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-completions",
				provider: "openrouter",
				model: "faux-1",
				usage: { input: 1, output: 1, total: 2 },
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "text", text }], timestamp: 3 },
		],
	} as unknown as TranscriptContext;
}

const ENV_KEYS = [
	"PI_EFFORT_LEVEL",
	"PI_ALWAYS_ENABLE_EFFORT",
	"PI_MAX_THINKING_TOKENS",
	"PI_DISABLE_THINKING",
	"PI_DISABLE_ADAPTIVE_THINKING",
];

beforeEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
});

describe("shouldUseAdaptiveThinking", () => {
	it("is true when the model compat forces adaptive thinking", () => {
		assert.equal(shouldUseAdaptiveThinking(makeModel({ compat: { forceAdaptiveThinking: true } })), true);
	});

	it("is false without the compat flag", () => {
		assert.equal(shouldUseAdaptiveThinking(makeModel()), false);
	});

	it("PI_DISABLE_ADAPTIVE_THINKING forces it off", () => {
		process.env.PI_DISABLE_ADAPTIVE_THINKING = "1";
		assert.equal(shouldUseAdaptiveThinking(makeModel({ compat: { forceAdaptiveThinking: true } })), false);
	});

	it("PI_DISABLE_THINKING forces it off", () => {
		process.env.PI_DISABLE_THINKING = "1";
		assert.equal(shouldUseAdaptiveThinking(makeModel({ compat: { forceAdaptiveThinking: true } })), false);
	});
});

describe("effortToThinkingLevel", () => {
	it("maps low/medium/high straight across", () => {
		const model = makeModel();
		assert.equal(effortToThinkingLevel(model, "low"), "low");
		assert.equal(effortToThinkingLevel(model, "medium"), "medium");
		assert.equal(effortToThinkingLevel(model, "high"), "high");
	});

	it("maps max to xhigh when the model supports it", () => {
		const model = makeModel({ thinkingLevelMap: { xhigh: "xhigh" } });
		assert.equal(effortToThinkingLevel(model, "max"), "xhigh");
	});

	it("downgrades max to high when xhigh is unsupported (CC behavior)", () => {
		assert.equal(effortToThinkingLevel(makeModel(), "max"), "high");
		const nullMapped = makeModel({ thinkingLevelMap: { xhigh: null } });
		assert.equal(effortToThinkingLevel(nullMapped, "max"), "high");
	});
});

describe("resolveAppliedEffort", () => {
	it("returns clear with no env override and no session level", () => {
		assert.deepEqual(resolveAppliedEffort(makeModel(), undefined), { kind: "clear" });
	});

	it("honors the session level when no env override is set", () => {
		assert.deepEqual(resolveAppliedEffort(makeModel(), "high"), { kind: "level", level: "high" });
		assert.deepEqual(resolveAppliedEffort(makeModel(), "minimal"), { kind: "level", level: "minimal" });
	});

	it("session level off resolves to off", () => {
		assert.deepEqual(resolveAppliedEffort(makeModel(), "off"), { kind: "off" });
	});

	it("clamps a session level the model does not support", () => {
		// xhigh/max require an explicit thinkingLevelMap entry; a bare model downgrades to high.
		assert.deepEqual(resolveAppliedEffort(makeModel(), "xhigh"), { kind: "level", level: "high" });
	});

	it("PI_EFFORT_LEVEL low/medium/high apply over the session level", () => {
		process.env.PI_EFFORT_LEVEL = "low";
		assert.deepEqual(resolveAppliedEffort(makeModel(), "high"), { kind: "level", level: "low" });
		process.env.PI_EFFORT_LEVEL = "HIGH";
		assert.deepEqual(resolveAppliedEffort(makeModel(), undefined), { kind: "level", level: "high" });
	});

	it("PI_EFFORT_LEVEL=max downgrades on unsupported models", () => {
		process.env.PI_EFFORT_LEVEL = "max";
		assert.deepEqual(resolveAppliedEffort(makeModel(), undefined), { kind: "level", level: "high" });
		const xhigh = makeModel({ thinkingLevelMap: { xhigh: "xhigh" } });
		assert.deepEqual(resolveAppliedEffort(xhigh, undefined), { kind: "level", level: "xhigh" });
	});

	it("PI_EFFORT_LEVEL=off disables thinking", () => {
		process.env.PI_EFFORT_LEVEL = "off";
		assert.deepEqual(resolveAppliedEffort(makeModel(), "high"), { kind: "off" });
	});

	it("PI_EFFORT_LEVEL=auto/unset clears the session level", () => {
		for (const val of ["auto", "unset"]) {
			process.env.PI_EFFORT_LEVEL = val;
			assert.deepEqual(resolveAppliedEffort(makeModel(), "high"), { kind: "clear" }, val);
		}
	});

	it("unrecognized PI_EFFORT_LEVEL falls through to the session level", () => {
		process.env.PI_EFFORT_LEVEL = "bogus";
		assert.deepEqual(resolveAppliedEffort(makeModel(), "medium"), { kind: "level", level: "medium" });
	});

	it("non-reasoning model clears without erroring", () => {
		assert.deepEqual(resolveAppliedEffort(makeModel({ reasoning: false }), "high"), { kind: "clear" });
	});

	it("PI_ALWAYS_ENABLE_EFFORT lets a non-reasoning model resolve a level", () => {
		process.env.PI_ALWAYS_ENABLE_EFFORT = "1";
		assert.deepEqual(resolveAppliedEffort(makeModel({ reasoning: false }), "high"), {
			kind: "level",
			level: "high",
		});
	});

	it("PI_DISABLE_THINKING wins over everything", () => {
		process.env.PI_DISABLE_THINKING = "1";
		process.env.PI_EFFORT_LEVEL = "high";
		process.env.PI_ALWAYS_ENABLE_EFFORT = "1";
		assert.deepEqual(resolveAppliedEffort(makeModel(), "high"), { kind: "off" });
	});
});

describe("thinking budgets and defaults from env", () => {
	it("resolveThinkingBudgetsFromEnv parses PI_MAX_THINKING_TOKENS", () => {
		assert.equal(resolveThinkingBudgetsFromEnv(), undefined);
		process.env.PI_MAX_THINKING_TOKENS = "10000";
		assert.deepEqual(resolveThinkingBudgetsFromEnv(), { high: 10_000 });
	});

	it("resolveThinkingBudgetsFromEnv rejects zero/negative/invalid", () => {
		for (const bad of ["0", "-5", "abc", ""]) {
			process.env.PI_MAX_THINKING_TOKENS = bad;
			assert.equal(resolveThinkingBudgetsFromEnv(), undefined, bad);
		}
	});

	it("clampBudgetsToModel caps at maxTokens - 1 and drops undefined entries", () => {
		const model = makeModel(); // maxTokens 8192
		assert.deepEqual(clampBudgetsToModel(model, { high: 99_999, low: 100 }), { high: 8_191, low: 100 });
		assert.deepEqual(clampBudgetsToModel(model, {}), {});
	});

	it("resolveDefaultThinkingLevelFromEnv maps budget to high/off", () => {
		assert.equal(resolveDefaultThinkingLevelFromEnv(), undefined);
		process.env.PI_MAX_THINKING_TOKENS = "5000";
		assert.equal(resolveDefaultThinkingLevelFromEnv(), "high");
		process.env.PI_MAX_THINKING_TOKENS = "0";
		assert.equal(resolveDefaultThinkingLevelFromEnv(), "off");
	});

	it("PI_DISABLE_THINKING forces the default off", () => {
		process.env.PI_DISABLE_THINKING = "1";
		process.env.PI_MAX_THINKING_TOKENS = "5000";
		assert.equal(resolveDefaultThinkingLevelFromEnv(), "off");
	});
});

describe("detectUltrathink", () => {
	it("matches the keyword in the last user message", () => {
		assert.equal(detectUltrathink(contextWithLastUser("please ultrathink on this")), true);
		assert.equal(detectUltrathink(contextWithLastUser("ULTRATHINK")), true);
	});

	it("ignores the keyword in earlier messages or when absent", () => {
		const context = contextWithLastUser("no keyword here");
		assert.equal(detectUltrathink(context), false);
	});

	it("does not match substrings of other words", () => {
		assert.equal(detectUltrathink(contextWithLastUser("ultrathinking about it")), false);
		assert.equal(detectUltrathink(contextWithLastUser("preultrathink")), false);
	});
});

describe("wrapStreamFn", () => {
	function captureStreamFn(captured: SimpleStreamOptions[], models?: Model<any>[]): StreamFn {
		return ((model: Model<any>, _context: TranscriptContext, options?: SimpleStreamOptions) => {
			models?.push(model);
			captured.push(options ?? {});
			return "SENTINEL" as unknown as ReturnType<StreamFn>;
		}) as StreamFn;
	}

	it("applies PI_EFFORT_LEVEL to the request options", () => {
		process.env.PI_EFFORT_LEVEL = "high";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => "medium")(makeModel(), contextWithLastUser("hi"), {});
		assert.equal(captured[0].reasoning, "high");
	});

	it("honors the session level when no env override is set", () => {
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => "high")(makeModel(), contextWithLastUser("hi"), {});
		assert.equal(captured[0].reasoning, "high");
	});

	it("deletes reasoning when effort resolves to off", () => {
		process.env.PI_EFFORT_LEVEL = "off";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => "high")(makeModel(), contextWithLastUser("hi"), {
			reasoning: "high",
		});
		assert.equal("reasoning" in captured[0], false);
	});

	it("auto/unset strips the session level from the request", () => {
		process.env.PI_EFFORT_LEVEL = "auto";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => "high")(makeModel(), contextWithLastUser("hi"), {
			reasoning: "high",
		});
		assert.equal("reasoning" in captured[0], false);
	});

	it("keeps the caller's reasoning when only the session level is off", () => {
		// Session "off" means the caller never set reasoning; nothing to strip beyond that.
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => "off")(makeModel(), contextWithLastUser("hi"), {});
		assert.equal("reasoning" in captured[0], false);
	});

	it("merges PI_MAX_THINKING_TOKENS budgets into existing ones", () => {
		process.env.PI_MAX_THINKING_TOKENS = "7000";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => undefined)(makeModel(), contextWithLastUser("hi"), {
			thinkingBudgets: { low: 100 },
		});
		assert.deepEqual(captured[0].thinkingBudgets, { low: 100, high: 7000 });
	});

	it("clamps the env budget to the model's output window", () => {
		process.env.PI_MAX_THINKING_TOKENS = "99999";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => undefined)(makeModel(), contextWithLastUser("hi"), {});
		assert.deepEqual(captured[0].thinkingBudgets, { high: 8_191 }); // maxTokens 8192 - 1
	});

	it("passes the model through unchanged without PI_ALWAYS_ENABLE_EFFORT", () => {
		const captured: SimpleStreamOptions[] = [];
		const models: Model<any>[] = [];
		const model = makeModel();
		wrapStreamFn(captureStreamFn(captured, models), () => undefined)(model, contextWithLastUser("hi"), {});
		assert.equal(models[0], model);
	});

	it("PI_ALWAYS_ENABLE_EFFORT clones a non-reasoning model to reasoning: true", () => {
		process.env.PI_ALWAYS_ENABLE_EFFORT = "1";
		const captured: SimpleStreamOptions[] = [];
		const models: Model<any>[] = [];
		const model = makeModel({ reasoning: false });
		wrapStreamFn(captureStreamFn(captured, models), () => "low")(model, contextWithLastUser("hi"), {});
		assert.notEqual(models[0], model);
		assert.equal(models[0].reasoning, true);
		assert.equal(captured[0].reasoning, "low");
	});

	it("strips budgets for adaptive models even when env budgets are set", () => {
		process.env.PI_MAX_THINKING_TOKENS = "7000";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => undefined)(
			makeModel({ compat: { forceAdaptiveThinking: true } }),
			contextWithLastUser("hi"),
			{ thinkingBudgets: { low: 100 } },
		);
		assert.equal("thinkingBudgets" in captured[0], false);
	});

	it("fills a reasoning level for adaptive models when none is set", () => {
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => undefined)(
			makeModel({ compat: { forceAdaptiveThinking: true } }),
			contextWithLastUser("hi"),
			{},
		);
		assert.equal(captured[0].reasoning, "high");
	});

	it("keeps the resolved level for adaptive models instead of overwriting it", () => {
		process.env.PI_EFFORT_LEVEL = "low";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => undefined)(
			makeModel({ compat: { forceAdaptiveThinking: true } }),
			contextWithLastUser("hi"),
			{},
		);
		assert.equal(captured[0].reasoning, "low");
	});

	it("PI_DISABLE_ADAPTIVE_THINKING restores the budget path", () => {
		process.env.PI_DISABLE_ADAPTIVE_THINKING = "1";
		process.env.PI_MAX_THINKING_TOKENS = "7000";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => undefined)(
			makeModel({ compat: { forceAdaptiveThinking: true } }),
			contextWithLastUser("hi"),
			{},
		);
		assert.deepEqual(captured[0].thinkingBudgets, { high: 7000 });
	});

	it("ultrathink forces maximum effort for that turn, overriding the env level", () => {
		process.env.PI_EFFORT_LEVEL = "low";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => undefined)(
			makeModel(),
			contextWithLastUser("ultrathink please"),
			{},
		);
		assert.equal(captured[0].reasoning, "high");
	});

	it("ultrathink reaches xhigh on models that support it", () => {
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => undefined)(
			makeModel({ thinkingLevelMap: { xhigh: "xhigh" } }),
			contextWithLastUser("ultrathink please"),
			{},
		);
		assert.equal(captured[0].reasoning, "xhigh");
	});

	it("ultrathink does not fire when thinking is disabled", () => {
		process.env.PI_DISABLE_THINKING = "1";
		const captured: SimpleStreamOptions[] = [];
		wrapStreamFn(captureStreamFn(captured), () => "low")(makeModel(), contextWithLastUser("ultrathink please"), {
			reasoning: "low",
		});
		assert.equal("reasoning" in captured[0], false);
	});

	it("passes through the wrapped streamFn's return value", () => {
		const wrapped = wrapStreamFn(captureStreamFn([]), () => undefined);
		const result = wrapped(makeModel(), contextWithLastUser("hi"), {});
		assert.equal(result, "SENTINEL");
	});
});

describe("env truthiness helpers", () => {
	it("isThinkingDisabled / isAdaptiveThinkingDisabled / isAlwaysEnableEffort", () => {
		assert.equal(isThinkingDisabled(), false);
		assert.equal(isAdaptiveThinkingDisabled(), false);
		assert.equal(isAlwaysEnableEffort(), false);
		process.env.PI_DISABLE_THINKING = "1";
		assert.equal(isThinkingDisabled(), true);
		process.env.PI_DISABLE_ADAPTIVE_THINKING = "true";
		assert.equal(isAdaptiveThinkingDisabled(), true);
		process.env.PI_ALWAYS_ENABLE_EFFORT = "1";
		assert.equal(isAlwaysEnableEffort(), true);
	});
});

// Type-level assertion: ThinkingLevel is used so tsgo checks the public surface.
const _level: ThinkingLevel | undefined = undefined as unknown as ThinkingLevel | undefined;
void _level;

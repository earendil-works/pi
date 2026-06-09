import { describe, it, expect } from "vitest";
import { normalizeOptions, formatOptionForSelect, registerAskUserQuestion } from "../ask_user_question.ts";

describe("normalizeOptions", () => {
	it("handles standard array of {label, description}", () => {
		const input = [{ label: "A", description: "a" }];
		expect(normalizeOptions(input)).toEqual([{ label: "A", description: "a" }]);
	});

	it("unwraps single-level {item: [...]} wrapper", () => {
		const input = { item: [{ label: "A", description: "a" }] };
		expect(normalizeOptions(input)).toEqual([{ label: "A", description: "a" }]);
	});

	it("recursively unwraps {item: {item: [...]}}", () => {
		const input = { item: { item: [{ label: "A", description: "a" }] } };
		expect(normalizeOptions(input)).toEqual([{ label: "A", description: "a" }]);
	});

	it("recursively unwraps {item: {item: {item: [...]}}}", () => {
		const input = { item: { item: { item: [{ label: "A" }] } } };
		expect(normalizeOptions(input)).toEqual([{ label: "A" }]);
	});

	it("treats missing description as undefined (does not throw)", () => {
		const input = [{ label: "A" }];
		expect(normalizeOptions(input)).toEqual([{ label: "A", description: undefined }]);
	});

	it("returns [] for empty array", () => {
		expect(normalizeOptions([])).toEqual([]);
	});

	it("returns [] for null", () => {
		expect(normalizeOptions(null)).toEqual([]);
	});

	it("returns [] for undefined", () => {
		expect(normalizeOptions(undefined)).toEqual([]);
	});

	it("handles flat string array (model-hallucinated format)", () => {
		const input = ["红色", "蓝色", "绿色"];
		expect(normalizeOptions(input)).toEqual([
			{ label: "红色" },
			{ label: "蓝色" },
			{ label: "绿色" },
		]);
	});

	it("handles mixed string + object array", () => {
		const input = ["红色", { label: "蓝色", description: "calm" }];
		expect(normalizeOptions(input)).toEqual([
			{ label: "红色" },
			{ label: "蓝色", description: "calm" },
		]);
	});

	it("handles string array inside {item: ...} wrapper", () => {
		const input = { item: ["红色", "蓝色"] };
		expect(normalizeOptions(input)).toEqual([{ label: "红色" }, { label: "蓝色" }]);
	});
});

describe("formatOptionForSelect", () => {
	it("returns just label when no description", () => {
		expect(formatOptionForSelect({ label: "Yes" })).toBe("Yes");
	});

	it("combines label and description with em-dash separator", () => {
		expect(formatOptionForSelect({ label: "Yes", description: "accept it" })).toBe("Yes — accept it");
	});
});

describe("registerAskUserQuestion", () => {
	function makeMockPi() {
		const calls = {
			selectArgs: [] as any[],
			inputArgs: [] as any[],
			registerCalls: [] as any[],
		};
		const pi = {
			registerTool: (tool: any) => {
				calls.registerCalls.push(tool);
			},
		};
		return { pi, calls };
	}

	// --- Registration tests ---
	it("calls pi.registerTool once when registering", () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		expect(calls.registerCalls).toHaveLength(1);
	});

	it("registers a tool named 'ask_user_question'", () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		expect(calls.registerCalls[0].name).toBe("ask_user_question");
	});

	it("registered tool has parameters (TypeBox schema) and execute function", () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		const tool = calls.registerCalls[0];
		expect(tool).toHaveProperty("parameters");
		expect(typeof tool.execute).toBe("function");
	});

	// --- Execute tests ---
	it("single-select happy path calls ui.select with correct args and returns text", async () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		const tool = calls.registerCalls[0];

		const ctx = {
			ui: {
				select: (...args: any[]) => {
					calls.selectArgs.push(args);
					return Promise.resolve("Option 1");
				},
			},
		} as any;

		const result = await tool.execute(
			"test-call",
			{ question: "Pick one", options: [{ label: "Option 1" }, { label: "Option 2" }, { label: "Option 3" }, { label: "Option 4" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(calls.selectArgs[0][0]).toBe("Pick one"); // title
		expect(calls.selectArgs[0][1]).toContain("Option 1"); // labels
		expect(result).toEqual({ content: [{ type: "text", text: "User selected: Option 1" }] });
	});

	it("multi-select happy path calls ui.input with joined labels and returns multi-select text", async () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		const tool = calls.registerCalls[0];

		const ctx = {
			ui: {
				select: () => Promise.resolve(undefined),
				input: (...args: any[]) => {
					calls.inputArgs.push(args);
					return Promise.resolve("A, B");
				},
			},
		} as any;

		const result = await tool.execute(
			"test-call",
			{
				question: "Pick several",
				options: [{ label: "A" }, { label: "B" }],
				multiSelect: true,
			},
			undefined,
			undefined,
			ctx,
		);

		// input should be called with title and placeholder (joined labels)
		expect(calls.inputArgs[0][0]).toBe("Pick several"); // title
		expect(result.content[0].text).toContain("User selected: A, B (multi-select)");
	});

	it("cancel (undefined from select) returns text containing 'cancelled'", async () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		const tool = calls.registerCalls[0];

		const ctx = {
			ui: {
				select: () => Promise.resolve(undefined),
			},
		} as any;

		const result = await tool.execute(
			"test-call",
			{ question: "Pick one", options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0].text).toContain("cancelled");
	});

	it("options=1 (invalid) returns isError without calling ui", async () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		const tool = calls.registerCalls[0];

		const ctx = {
			ui: {
				select: (...args: any[]) => {
					calls.selectArgs.push(args);
					return Promise.resolve("A");
				},
			},
		} as any;

		const result = await tool.execute(
			"test-call",
			{ question: "Pick one", options: [{ label: "Only One" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(calls.selectArgs).toHaveLength(0); // no ui call
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/at least 2|between 2 and 4/);
	});

	it("options=5 (invalid) returns isError without calling ui", async () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		const tool = calls.registerCalls[0];

		const ctx = {
			ui: {
				select: (...args: any[]) => {
					calls.selectArgs.push(args);
					return Promise.resolve("A");
				},
			},
		} as any;

		const result = await tool.execute(
			"test-call",
			{
				question: "Pick one",
				options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(calls.selectArgs).toHaveLength(0); // no ui call
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/at least 2|between 2 and 4/);
	});

	it("missing question field returns isError without calling ui", async () => {
		const { pi, calls } = makeMockPi();
		registerAskUserQuestion(pi);
		const tool = calls.registerCalls[0];

		const ctx = {
			ui: {
				select: (...args: any[]) => {
					calls.selectArgs.push(args);
					return Promise.resolve("A");
				},
			},
		} as any;

		// @ts-ignore — intentionally passing invalid args
		const result = await tool.execute("test-call", { options: [{ label: "A" }, { label: "B" }] }, undefined, undefined, ctx);

		expect(calls.selectArgs).toHaveLength(0); // no ui call
		expect(result.isError).toBe(true);
	});
});

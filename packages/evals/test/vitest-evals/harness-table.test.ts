import { describe, expect, it } from "vitest";
import { createHarness, type HarnessContext } from "vitest-evals/harness";
import {
	deriveEvalGroupKey,
	EVAL_HARNESS_ITERATION_ARTIFACT,
	evalHarnessTable,
	parseEvalHarnessIterationArtifact,
} from "../../src/vitest-evals/harness-table.ts";

describe("deriveEvalGroupKey", () => {
	it("combines a trimmed string input ID with repetition", () => {
		expect(deriveEvalGroupKey({ id: " input-1 ", prompt: "hello" }, 2)).toBe(JSON.stringify(["input-1", 2]));
	});

	it("hashes canonical JSON independently of object key order", () => {
		expect(deriveEvalGroupKey({ first: 1, second: [true, "value"] }, 1)).toBe(
			deriveEvalGroupKey({ second: [true, "value"], first: 1 }, 1),
		);
		expect(deriveEvalGroupKey({ first: 1 }, 1)).not.toBe(deriveEvalGroupKey({ first: 2 }, 1));
		expect(deriveEvalGroupKey({ first: 1 }, 1)).not.toBe(deriveEvalGroupKey({ first: 1 }, 2));
		expect(deriveEvalGroupKey(["first", "second"], 1)).not.toBe(deriveEvalGroupKey(["second", "first"], 1));
	});

	it("rejects non-JSON and circular input", () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => deriveEvalGroupKey(new Date(0), 1)).toThrow("only plain objects and arrays");
		expect(() => deriveEvalGroupKey(Array(1), 1)).toThrow("must not be sparse");
		expect(() => deriveEvalGroupKey(circular, 1)).toThrow("must not contain circular references");
	});
});

function createFakeHarness(name: string) {
	return createHarness<{ id: string }, { harness: string; inputId: string }>({
		name,
		run: ({ input }) => ({
			output: { harness: name, inputId: input.id },
			events: [
				{ type: "message", role: "user", content: input.id },
				{ type: "message", role: "assistant", content: name },
			],
		}),
	});
}

const harnessTable = evalHarnessTable("local multi-harness eval", {
	baseline: createFakeHarness("withoutSkill"),
	candidates: [createFakeHarness("withSkill")],
	repetitions: 2,
});

describe("evalHarnessTable", () => {
	it("plans repetitions in declaration order", () => {
		expect(harnessTable.map(({ name, repetition }) => ({ name, repetition }))).toEqual([
			{ name: "withoutSkill", repetition: 1 },
			{ name: "withSkill", repetition: 1 },
			{ name: "withoutSkill", repetition: 2 },
			{ name: "withSkill", repetition: 2 },
		]);
	});

	it("accepts a singular candidate", () => {
		const rows = evalHarnessTable("singular candidate", {
			baseline: createFakeHarness("baseline"),
			candidate: createFakeHarness("candidate"),
		});

		expect(rows.map(({ name }) => name)).toEqual(["baseline", "candidate"]);
	});

	it("attaches iteration metadata to every wrapped harness run", async () => {
		for (const row of harnessTable) {
			const artifacts: HarnessContext["artifacts"] = {};
			const context: HarnessContext = {
				artifacts,
				setArtifact(name, value) {
					artifacts[name] = value;
				},
			};
			const result = await row.harness.run({ id: "first" }, context);

			expect(result.output).toEqual({ harness: row.name, inputId: "first" });
			expect(parseEvalHarnessIterationArtifact(result.artifacts?.[EVAL_HARNESS_ITERATION_ARTIFACT])).toEqual({
				schemaVersion: 1,
				evalSet: "local multi-harness eval",
				groupKey: deriveEvalGroupKey({ id: "first" }, row.repetition),
				harness: row.name,
				baseline: "withoutSkill",
				candidates: ["withSkill"],
				repetition: row.repetition,
			});
		}
	});
});

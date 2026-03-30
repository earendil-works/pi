import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildMissionIterationPrompt } from "../src/missions/build-mission-prompt.js";
import { parseMissionDefinition } from "../src/missions/parse-mission.js";

interface ParsedMilestone {
	id: string;
	title: string;
	goal: string;
	taskIds: string[];
	gateTaskId: string;
	verification: Array<{
		id: string;
		kind: "command" | "xtui" | "cdp" | "log" | "assertion" | "diff";
		command: string;
		expect: string;
	}>;
	notes: string;
}

function makeMissionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mu-mission-milestones-red-"));
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function writeBuildMissionFiles(
	dir: string,
	options?: {
		tasksJson?: string;
		milestonesJson?: string;
	},
): void {
	writeFileSync(join(dir, "SPEC.md"), "---\nmode: build\n---\n\n# Spec\n");
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n");
	writeFileSync(join(dir, "RUNBOOK.md"), "# Runbook\n");
	writeFileSync(
		join(dir, "TASKS.json"),
		options?.tasksJson ??
			JSON.stringify(
				{
					tasks: [
						{
							id: "runner-red-test",
							title: "Add failing runner test",
							status: "done",
							validation: ["npm test -w @kennyfrc/mu-coding-agent -- mission-reset-runner.red.test.ts"],
							notes: "Red proof exists.",
						},
						{
							id: "runner-implementation",
							title: "Implement reset barrier behavior",
							status: "done",
							validation: ["npm test -w @kennyfrc/mu-coding-agent -- mission-reset-runner.red.test.ts"],
							notes: "Turn red to green.",
						},
						{
							id: "runner-acceptance-gate",
							title: "Verify milestone runner-reset",
							status: "todo",
							validation: ["Milestone runner-reset verification passes"],
							notes: "Do not mark done until milestone verification is green.",
						},
					],
				},
				null,
				2,
			),
	);
	if (options?.milestonesJson !== undefined) {
		writeFileSync(join(dir, "MILESTONES.json"), options.milestonesJson);
	}
}

describe("mission milestones contract (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("parses MILESTONES.json and exposes milestone contracts alongside the mission definition", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeBuildMissionFiles(dir, {
			milestonesJson: JSON.stringify(
				{
					milestones: [
						{
							id: "runner-reset",
							title: "Runner honors reset barrier",
							goal: "A reset optimize mission can resume without immediately halting on stale convergence.",
							taskIds: ["runner-red-test", "runner-implementation", "runner-acceptance-gate"],
							gateTaskId: "runner-acceptance-gate",
							verification: [
								{
									id: "runner-test-green",
									kind: "command",
									command: "npm test -w @kennyfrc/mu-coding-agent -- mission-reset-runner.red.test.ts",
									expect: "exit 0",
								},
								{
									id: "runner-xtui-flow",
									kind: "xtui",
									command: "run /mission-reset <fixture> then /mission-resume <fixture>",
									expect: "mission executes again",
								},
							],
							notes: "Gate closes the milestone.",
						},
					],
				},
				null,
				2,
			),
		});

		const mission = parseMissionDefinition(dir) as unknown as { milestones?: ParsedMilestone[] };

		expect(mission.milestones).toEqual([
			{
				id: "runner-reset",
				title: "Runner honors reset barrier",
				goal: "A reset optimize mission can resume without immediately halting on stale convergence.",
				taskIds: ["runner-red-test", "runner-implementation", "runner-acceptance-gate"],
				gateTaskId: "runner-acceptance-gate",
				verification: [
					{
						id: "runner-test-green",
						kind: "command",
						command: "npm test -w @kennyfrc/mu-coding-agent -- mission-reset-runner.red.test.ts",
						expect: "exit 0",
					},
					{
						id: "runner-xtui-flow",
						kind: "xtui",
						command: "run /mission-reset <fixture> then /mission-resume <fixture>",
						expect: "mission executes again",
					},
				],
				notes: "Gate closes the milestone.",
			},
		]);
	});

	it("rejects a milestone whose verification entries are legacy strings instead of structured records", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeBuildMissionFiles(dir, {
			milestonesJson: JSON.stringify({
				milestones: [
					{
						id: "runner-reset",
						title: "Runner honors reset barrier",
						goal: "A reset optimize mission can resume again.",
						taskIds: ["runner-red-test", "runner-implementation"],
						gateTaskId: "runner-acceptance-gate",
						verification: ["npm test -w @kennyfrc/mu-coding-agent -- mission-reset-runner.red.test.ts"],
						notes: "Legacy string verification should be rejected.",
					},
				],
			}),
		});

		expect(() => parseMissionDefinition(dir)).toThrow(/verification|object|id|kind|command|expect/i);
	});

	it("rejects a milestone whose gateTaskId is not part of that milestone's taskIds", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeBuildMissionFiles(dir, {
			milestonesJson: JSON.stringify({
				milestones: [
					{
						id: "runner-reset",
						title: "Runner honors reset barrier",
						goal: "A reset optimize mission can resume again.",
						taskIds: ["runner-red-test", "runner-implementation"],
						gateTaskId: "runner-acceptance-gate",
						verification: [
							{
								id: "runner-test-green",
								kind: "command",
								command: "npm test -w @kennyfrc/mu-coding-agent -- mission-reset-runner.red.test.ts",
								expect: "exit 0",
							},
						],
						notes: "Invalid gate membership.",
					},
				],
			}),
		});

		expect(() => parseMissionDefinition(dir)).toThrow(/gateTaskId|taskIds|runner-acceptance-gate/i);
	});

	it("rejects a milestone that references task ids missing from TASKS.json", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeBuildMissionFiles(dir, {
			milestonesJson: JSON.stringify({
				milestones: [
					{
						id: "runner-reset",
						title: "Runner honors reset barrier",
						goal: "A reset optimize mission can resume again.",
						taskIds: ["runner-red-test", "runner-missing", "runner-acceptance-gate"],
						gateTaskId: "runner-acceptance-gate",
						verification: [
							{
								id: "runner-test-green",
								kind: "command",
								command: "npm test -w @kennyfrc/mu-coding-agent -- mission-reset-runner.red.test.ts",
								expect: "exit 0",
							},
						],
						notes: "Invalid missing task reference.",
					},
				],
			}),
		});

		expect(() => parseMissionDefinition(dir)).toThrow(/runner-missing|taskIds|TASKS\.json/i);
	});

	it("includes MILESTONES.json and gate guidance in the build mission iteration prompt", () => {
		const { dir, cleanup } = makeMissionDir();
		cleanups.push(cleanup);
		writeBuildMissionFiles(dir, {
			milestonesJson: JSON.stringify({
				milestones: [
					{
						id: "runner-reset",
						title: "Runner honors reset barrier",
						goal: "A reset optimize mission can resume again.",
						taskIds: ["runner-red-test", "runner-implementation", "runner-acceptance-gate"],
						gateTaskId: "runner-acceptance-gate",
						verification: [
							{
								id: "runner-test-green",
								kind: "command",
								command: "npm test -w @kennyfrc/mu-coding-agent -- mission-reset-runner.red.test.ts",
								expect: "exit 0",
							},
						],
						notes: "Acceptance gate closes the milestone.",
					},
				],
			}),
		});

		const mission = parseMissionDefinition(dir);
		const prompt = buildMissionIterationPrompt(mission);

		expect(prompt).toContain("MILESTONES.json");
		expect(prompt).toMatch(/milestone/i);
		expect(prompt).toMatch(/acceptance gate|gate task/i);
		expect(prompt).toContain("runner-reset");
		expect(prompt).toContain("runner-test-green");
		expect(prompt).toContain("exit 0");
	});
});

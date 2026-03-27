import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { buildMissionUiState, formatMissionMetaLabel } from "../src/missions/mission-ui.js";
import type { MissionDefinition } from "../src/missions/types.js";
import { initTheme } from "../src/theme/theme.js";

function makeMission(overrides?: Partial<MissionDefinition>): MissionDefinition {
	return {
		mode: "build",
		dir: "/tmp/example-mission",
		specPath: "/tmp/example-mission/SPEC.md",
		tasksPath: "/tmp/example-mission/TASKS.json",
		milestonesPath: undefined,
		progressPath: "/tmp/example-mission/PROGRESS.md",
		runbookPath: "/tmp/example-mission/RUNBOOK.md",
		specText: "# Spec",
		progressText: "# Progress",
		runbookText: "# Runbook",
		milestones: [],
		tasks: [
			{ id: "done-task", title: "Already done", status: "done", validation: [], notes: "" },
			{ id: "feature", title: "Implement feature", status: "todo", validation: [], notes: "" },
		],
		allTasksDone: false,
		runnableTasks: [{ id: "feature", title: "Implement feature", status: "todo", validation: [], notes: "" }],
		...overrides,
	};
}

describe("mission footer label", () => {
	it("formats name, iteration, state, done count, and current task", () => {
		initTheme("dark");
		const state = buildMissionUiState({
			missionName: "example-mission",
			mission: makeMission(),
			iteration: 3,
			status: "running",
		});

		const label = stripAnsi(formatMissionMetaLabel(state));

		expect(label).toContain("mission example-mission");
		expect(label).toContain("iter 3");
		expect(label).toContain("running");
		expect(label).toContain("1/2 done");
		expect(label).toContain("task feature: Implement feature");
	});

	it("omits current task when no runnable task remains", () => {
		initTheme("dark");
		const doneMission = makeMission({
			tasks: [{ id: "done-task", title: "Already done", status: "done", validation: [], notes: "" }],
			allTasksDone: true,
			runnableTasks: [],
		});
		const state = buildMissionUiState({
			missionName: "example-mission",
			mission: doneMission,
			iteration: 1,
			status: "done",
		});

		const label = stripAnsi(formatMissionMetaLabel(state));

		expect(label).toContain("done");
		expect(label).toContain("1/1 done");
		expect(label).not.toContain("task ");
	});
});

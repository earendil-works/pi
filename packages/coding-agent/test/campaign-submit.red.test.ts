import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTransport } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type CampaignRenderer = {
	init(): Promise<void>;
	stop(): void;
	showError(errorMessage: string): void;
	showWarning(message: string): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
};

function stubMissionCompaction(renderer: CampaignRenderer): void {
	(
		renderer as CampaignRenderer & {
			buildSummaryCompactionDetails: (
				goal: string,
				signal: AbortSignal,
			) => Promise<{
				handoffType: "explicit";
				goal: string;
				formattedMessage: string;
				parentSessionId: string;
				fileTokens: number;
				keyFiles: string[];
			}>;
		}
	).buildSummaryCompactionDetails = async (goal: string) => ({
		handoffType: "explicit",
		goal,
		formattedMessage: `# Handoff\n${goal}`,
		parentSessionId: "",
		fileTokens: 0,
		keyFiles: [],
	});
}

function makeBuildMissionDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	writeFileSync(join(dir, "SPEC.md"), "# Goal\nShip /mission-run\n");
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n\n## Status\n- not done\n");
	writeFileSync(join(dir, "RUNBOOK.md"), "# Runbook\n\n1. Work one task at a time.\n");
	writeFileSync(
		join(dir, "TASKS.json"),
		JSON.stringify(
			{
				tasks: [{ id: "baseline", title: "Still todo", status: "todo", validation: [], notes: "" }],
			},
			null,
			2,
		),
	);
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function markMissionDone(dir: string): void {
	writeFileSync(
		join(dir, "TASKS.json"),
		JSON.stringify(
			{
				tasks: [{ id: "baseline", title: "Done", status: "done", validation: [], notes: "" }],
			},
			null,
			2,
		),
	);
}

function makeCampaignDir(missionPaths: string[]): { dir: string; campaignPath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "mu-campaign-submit-red-"));
	const campaignPath = join(dir, "campaign.json");
	writeFileSync(campaignPath, JSON.stringify({ missions: missionPaths }, null, 2));
	return {
		dir,
		campaignPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("/campaign-run submission (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("runs missions in sequence from an explicit campaign path and advances only after each mission is done", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-campaign-submit-config-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const missionA = makeBuildMissionDir("mu-campaign-mission-a-");
		const missionB = makeBuildMissionDir("mu-campaign-mission-b-");
		cleanups.push(missionA.cleanup, missionB.cleanup);

		const campaign = makeCampaignDir([missionA.dir, missionB.dir]);
		cleanups.push(campaign.cleanup);

		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";
		cleanups.push(() => {
			if (previousOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiKey;
			}
		});

		let runCalls = 0;
		const transport: AgentTransport = {
			async *run() {
				runCalls += 1;
				if (runCalls === 1) {
					markMissionDone(missionA.dir);
				} else if (runCalls === 2) {
					markMissionDone(missionB.dir);
				}
				yield* [];
			},
		};

		const agent = new Agent({
			transport,
			initialState: {
				model: getModel("openai", "gpt-4o-mini"),
				thinkingLevel: "medium",
			},
		});

		const renderer = new TuiRenderer(
			agent,
			{
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "campaign-submit-red",
			} as never,
			new SettingsManager(configDir),
			{
				listCommands: () => [],
				getCommand: () => undefined,
				applyInputHooks: async (text: string) => ({ handled: false, text }),
				composeToolResultTransformer: <T>(base: T) => base,
			} as never,
			{} as never,
			"0.0.0",
		) as unknown as CampaignRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());
		stubMissionCompaction(renderer);

		const errors: string[] = [];
		const warnings: string[] = [];
		renderer.showError = (message: string) => {
			errors.push(message);
		};
		renderer.showWarning = (message: string) => {
			warnings.push(message);
		};

		await renderer.handleEditorTextSubmission(`/campaign-run ${campaign.campaignPath}`, "by-end");

		expect(errors).toEqual([]);
		expect(runCalls).toBe(2);
		expect(warnings.join("\n")).toMatch(/campaign.*done/i);
	});
});

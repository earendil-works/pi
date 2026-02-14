import type { AgentTool } from "@kennyfrc/mu-ai";
import { StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";
import { getToolDescription } from "../prompts/index.js";
import { findRepoRoot } from "../utils/find-repo-root.js";

type PlanStatus = "pending" | "in_progress" | "completed";

const PlanStatusSchema = StringEnum(["pending", "in_progress", "completed"] as const, {
	description: "Task status: pending, in_progress, completed",
});

const PlanItemSchema = Type.Object({
	step: Type.String({ description: "One concrete step." }),
	status: PlanStatusSchema,
});

const updatePlanSchema = Type.Object({
	explanation: Type.Optional(Type.String({ description: "Optional short explanation of changes." })),
	plan: Type.Array(PlanItemSchema, { description: "Full plan. Replaces the previous plan." }),
});

export interface UpdatePlanToolDetails {
	path: string;
	explanation?: string;
	plan: Array<{ step: string; status: PlanStatus }>;
}

function getWhoAmIFromEnv(): { sessionId: string; runId: string } {
	const sessionId = process.env.MU_SESSION_ID;
	const runId = process.env.MU_RUN_ID;
	if (!sessionId || !runId) {
		throw new Error(
			"Missing MU_SESSION_ID or MU_RUN_ID. The mu CLI must set these environment variables at startup.",
		);
	}
	return { sessionId, runId };
}

function resolvePlanRootDir(params: {
	cwd: string;
	envPlanPath?: string | undefined;
	repoRoot?: string | null;
}): string {
	const repoRoot = params.repoRoot ?? findRepoRoot(params.cwd) ?? null;
	const env = params.envPlanPath?.trim();

	if (env) {
		if (isAbsolute(env)) {
			return resolve(env);
		}
		const base = repoRoot ?? params.cwd;
		return resolve(base, env);
	}

	const base = repoRoot ?? params.cwd;
	return resolve(base, ".mu", "plans");
}

function getPlanFilePathForCwd(cwd: string, sessionId: string): string {
	const repoRoot = findRepoRoot(cwd);
	const rootDir = resolvePlanRootDir({ cwd, envPlanPath: process.env.MU_PLAN_PATH, repoRoot });
	return resolve(rootDir, `${sessionId}.json`);
}

function formatPlanText(explanation: string | undefined, plan: Array<{ step: string; status: PlanStatus }>): string {
	const lines = plan.map((p) => `- [${p.status}] ${p.step}`);
	if (!explanation?.trim()) {
		return lines.length > 0 ? lines.join("\n") : "Plan is empty";
	}
	return [`Explanation: ${explanation.trim()}`, "", ...lines].join("\n");
}

export const updatePlanTool: AgentTool<typeof updatePlanSchema, UpdatePlanToolDetails> = {
	name: "update_plan",
	label: "update_plan",
	description: getToolDescription("update_plan"),
	parameters: updatePlanSchema,
	execute: async (
		_toolCallId: string,
		{
			explanation,
			plan,
		}: {
			explanation?: string;
			plan: Array<{ step: string; status: PlanStatus }>;
		},
		_signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		const who = getWhoAmIFromEnv();
		const filePath = getPlanFilePathForCwd(process.cwd(), who.sessionId);

		await mkdir(dirname(filePath), { recursive: true });
		const payload = {
			sessionId: who.sessionId,
			runId: who.runId,
			updatedAt: new Date().toISOString(),
			explanation: explanation?.trim() || undefined,
			plan,
		};
		await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");

		return {
			content: [{ type: "text", text: formatPlanText(explanation, plan) }],
			details: { path: filePath, explanation: explanation?.trim() || undefined, plan },
		};
	},
};

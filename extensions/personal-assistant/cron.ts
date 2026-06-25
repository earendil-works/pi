/**
 * Cron Extension
 *
 * Manages scheduled tasks for the Pi personal assistant.
 * Supports three schedule types:
 * - "at": daily at a specific time (e.g., "09:00")
 * - "every": recurring interval in seconds
 * - "cron": simple cron expression with minute/hour/weekday matching
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ============================================================================
// Types
// ============================================================================

interface CronJob {
	id: string;
	name: string;
	schedule: Schedule;
	prompt: string;
	enabled: boolean;
	last_run: string | null;
	last_run_status?: "ok" | "error" | null;
	created_at: string;
}

type Schedule =
	| { kind: "at"; time: string }
	| { kind: "every"; interval: number }
	| { kind: "cron"; expr: string; tz?: string };

// ============================================================================
// Storage
// ============================================================================

function getDataPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "data", "cron.json");
}

function ensureDataDir(): void {
	const dir = path.dirname(getDataPath());
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function loadJobs(): CronJob[] {
	const filePath = getDataPath();
	if (!fs.existsSync(filePath)) {
		return [];
	}
	try {
		const data = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(data) as CronJob[];
	} catch {
		return [];
	}
}

function saveJobs(jobs: CronJob[]): void {
	ensureDataDir();
	fs.writeFileSync(getDataPath(), JSON.stringify(jobs, null, 2), "utf-8");
}

// ============================================================================
// Cron Expression Parser (simple minute/hour/weekday matching)
// ============================================================================

interface ParsedCron {
	minutes: Set<number>;
	hours: Set<number>;
	weekdays: Set<number>; // 0=Sun, 1=Mon, ..., 6=Sat
}

function parseCronField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();

	for (const part of field.split(",")) {
		if (part === "*") {
			for (let i = min; i <= max; i++) {
				values.add(i);
			}
		} else if (part.startsWith("*/")) {
			const step = parseInt(part.slice(2), 10);
			if (step > 0) {
				for (let i = min; i <= max; i += step) {
					values.add(i);
				}
			}
		} else if (part.includes("-")) {
			const [start, end] = part.split("-").map(Number);
			if (!isNaN(start) && !isNaN(end) && start >= min && end <= max) {
				for (let i = start; i <= end; i++) {
					values.add(i);
				}
			}
		} else {
			const num = parseInt(part, 10);
			if (!isNaN(num) && num >= min && num <= max) {
				values.add(num);
			}
		}
	}

	return values;
}

function parseCronExpression(expr: string): ParsedCron | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length < 5) {
		return null;
	}

	const minutes = parseCronField(parts[0], 0, 59);
	const hours = parseCronField(parts[1], 0, 23);
	// Day of month (parts[2]) - skip for simplicity
	// Month (parts[3]) - skip for simplicity
	const weekdays = parseCronField(parts[4], 0, 6);

	return { minutes, hours, weekdays };
}

function matchesCron(parsed: ParsedCron, date: Date): boolean {
	return (
		parsed.minutes.has(date.getMinutes()) &&
		parsed.hours.has(date.getHours()) &&
		parsed.weekdays.has(date.getDay())
	);
}

// ============================================================================
// Schedule Checking
// ============================================================================

export function isOverdue(job: CronJob, now: Date): boolean {
	if (!job.enabled) {
		return false;
	}

	switch (job.schedule.kind) {
		case "at": {
			const [targetHour, targetMin] = job.schedule.time.split(":").map(Number);
			const currentHour = now.getHours();
			const currentMin = now.getMinutes();

			// Check if current time is past the scheduled time
			const isPastTime = currentHour > targetHour || (currentHour === targetHour && currentMin >= targetMin);

			// Check if not already run today
			if (job.last_run) {
				const lastRun = new Date(job.last_run);
				const isToday =
					lastRun.getFullYear() === now.getFullYear() &&
					lastRun.getMonth() === now.getMonth() &&
					lastRun.getDate() === now.getDate();
				return isPastTime && !isToday;
			}

			return isPastTime;
		}

		case "every": {
			if (!job.last_run) {
				return true;
			}
			const lastRun = new Date(job.last_run).getTime();
			const intervalMs = job.schedule.interval * 1000;
			return now.getTime() - lastRun >= intervalMs;
		}

		case "cron": {
			const parsed = parseCronExpression(job.schedule.expr);
			if (!parsed) {
				return false;
			}

			// Check if current minute matches
			if (!matchesCron(parsed, now)) {
				return false;
			}

			// Check if not already run this minute
			if (job.last_run) {
				const lastRun = new Date(job.last_run);
				const isSameMinute =
					lastRun.getFullYear() === now.getFullYear() &&
					lastRun.getMonth() === now.getMonth() &&
					lastRun.getDate() === now.getDate() &&
					lastRun.getHours() === now.getHours() &&
					lastRun.getMinutes() === now.getMinutes();
				return !isSameMinute;
			}

			return true;
		}

		default:
			return false;
	}
}

// ============================================================================
// Tool Definition
// ============================================================================

const cronWriteParams = Type.Object({
	operations: Type.Array(
		Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("list"),
				Type.Literal("remove"),
				Type.Literal("toggle"),
				Type.Literal("trigger_now"),
			]),
			name: Type.Optional(Type.String()),
			schedule: Type.Optional(
				Type.Object({
					kind: Type.Union([Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")]),
					time: Type.Optional(Type.String()),
					interval: Type.Optional(Type.Number()),
					expr: Type.Optional(Type.String()),
					tz: Type.Optional(Type.String()),
				}),
			),
			prompt: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			enabled: Type.Optional(Type.Boolean()),
		}),
	),
	merge: Type.Optional(Type.Boolean()),
});

interface OperationResult {
	action: string;
	success: boolean;
	message: string;
	job?: CronJob;
	jobs?: CronJob[];
}

function executeOperation(
	action: string,
	jobs: CronJob[],
	params: {
		name?: string;
		schedule?: Schedule;
		prompt?: string;
		id?: string;
		enabled?: boolean;
	},
): { jobs: CronJob[]; result: OperationResult } {
	switch (action) {
		case "add": {
			if (!params.name || !params.schedule || !params.prompt) {
				return {
					jobs,
					result: {
						action,
						success: false,
						message: "Missing required fields: name, schedule, prompt",
					},
				};
			}

			const newJob: CronJob = {
				id: crypto.randomUUID(),
				name: params.name,
				schedule: params.schedule,
				prompt: params.prompt,
				enabled: true,
				last_run: null,
				last_run_status: null,
				created_at: new Date().toISOString(),
			};

			return {
				jobs: [...jobs, newJob],
				result: {
					action,
					success: true,
					message: `Added job: ${newJob.name}`,
					job: newJob,
				},
			};
		}

		case "list": {
			return {
				jobs,
				result: {
					action,
					success: true,
					message: `Found ${jobs.length} jobs`,
					jobs,
				},
			};
		}

		case "remove": {
			if (!params.id) {
				return {
					jobs,
					result: {
						action,
						success: false,
						message: "Missing required field: id",
					},
				};
			}

			const job = jobs.find((j) => j.id === params.id);
			if (!job) {
				return {
					jobs,
					result: {
						action,
						success: false,
						message: `Job not found: ${params.id}`,
					},
				};
			}

			return {
				jobs: jobs.filter((j) => j.id !== params.id),
				result: {
					action,
					success: true,
					message: `Removed job: ${job.name}`,
					job,
				},
			};
		}

		case "toggle": {
			if (!params.id) {
				return {
					jobs,
					result: {
						action,
						success: false,
						message: "Missing required field: id",
					},
				};
			}

			const jobIndex = jobs.findIndex((j) => j.id === params.id);
			if (jobIndex === -1) {
				return {
					jobs,
					result: {
						action,
						success: false,
						message: `Job not found: ${params.id}`,
					},
				};
			}

			const updatedJobs = [...jobs];
			const job = { ...updatedJobs[jobIndex] };
			job.enabled = params.enabled ?? !job.enabled;
			updatedJobs[jobIndex] = job;

			return {
				jobs: updatedJobs,
				result: {
					action,
					success: true,
					message: `${job.enabled ? "Enabled" : "Disabled"} job: ${job.name}`,
					job,
				},
			};
		}

		case "trigger_now": {
			if (!params.id) {
				return {
					jobs,
					result: {
						action,
						success: false,
						message: "Missing required field: id",
					},
				};
			}

			const jobIndex = jobs.findIndex((j) => j.id === params.id);
			if (jobIndex === -1) {
				return {
					jobs,
					result: {
						action,
						success: false,
						message: `Job not found: ${params.id}`,
					},
				};
			}

			const updatedJobs = [...jobs];
			const job = { ...updatedJobs[jobIndex] };
			job.last_run = null;
			updatedJobs[jobIndex] = job;

			return {
				jobs: updatedJobs,
				result: {
					action,
					success: true,
					message: `Triggered job: ${job.name}`,
					job,
				},
			};
		}

		default:
			return {
				jobs,
				result: {
					action,
					success: false,
					message: `Unknown action: ${action}`,
				},
			};
	}
}

// ============================================================================
// Extension Registration
// ============================================================================

export function registerCron(pi: ExtensionAPI): void {
	// Register the cron_write tool
	pi.registerTool({
		name: "cron_write",
		label: "Cron Management",
		description: "Manage scheduled tasks. Add, list, remove, toggle, or trigger cron jobs.",
		promptSnippet: "Manage scheduled tasks and reminders",
		promptGuidelines: [
			"Use cron_write to schedule recurring tasks or reminders.",
			"Supports three schedule types: 'at' (daily at time), 'every' (interval in seconds), 'cron' (cron expression).",
			"Example: Add a daily standup reminder at 9am on weekdays.",
		],
		parameters: cronWriteParams,

		async execute(_toolCallId, params) {
			let jobs = loadJobs();
			const results: OperationResult[] = [];

			for (const op of params.operations) {
				const { jobs: updatedJobs, result } = executeOperation(op.action, jobs, {
					name: op.name,
					schedule: op.schedule as Schedule | undefined,
					prompt: op.prompt,
					id: op.id,
					enabled: op.enabled,
				});
				jobs = updatedJobs;
				results.push(result);
			}

			saveJobs(jobs);

			const summary = results
				.map((r) => `${r.success ? "OK" : "FAIL"}: ${r.message}`)
				.join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: { results, jobs },
			};
		},
	});

	// NOTE: A previous implementation called pi.sendUserMessage on every
	// session_start for each overdue job. That made every new pi session
	// re-trigger any overdue "every N seconds" cron job, creating duplicate
	// TUI sessions in the webui sidebar and unnecessary LLM calls. The
	// correct design is: cron is time-driven (a separate background
	// scheduler, planned in change "add-cron-time-scheduler" that mirrors
	// nanobot's CronService). For now, session_start is intentionally a
	// no-op for cron — use the webui cron UI's "Trigger Now" button to
	// run a job manually.
}

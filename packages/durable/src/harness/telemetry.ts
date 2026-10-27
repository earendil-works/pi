import { defineTelemetrySchema } from "@earendil-works/pi-telemetry";

const entry = {
	description: "A transcript entry was committed; content remains in the transcript.",
	attributes: {
		"entry.id": { type: "number", required: true, description: "Transcript entry ID.", cardinality: "high" },
		"entry.kind": { type: "string", required: true, description: "Entry kind." },
	},
} as const;
const reportAttributes = {
	type: {
		type: "string",
		required: true,
		description: "ReportInfo type.",
		values: [
			"session_failed",
			"task_faulted",
			"task_parked",
			"migration_failed",
			"task_outdated",
			"task_error",
			"extension_error",
			"host_error",
			"listener_error",
		],
	},
	reason: {
		type: "string",
		required: false,
		description: "Fixed report reason, when present.",
		values: ["threw", "restart_limit", "missing_task", "incompatible_task"],
	},
	extension: { type: "string", required: false, description: "Registered extension name, when present." },
	"task.id": { type: "number", required: false, description: "Task ID, when present.", cardinality: "high" },
} as const;
const report = {
	description: "A report was raised; no error payload is recorded.",
	attributes: reportAttributes,
} as const;
const submission = {
	description: "A submission was settled.",
	attributes: {
		"submission.id": { type: "number", required: true, description: "Submission ID.", cardinality: "high" },
		status: { type: "string", required: true, values: ["done", "unanswered"], description: "Settlement." },
		"answer.entry_id": { type: "number", required: false, description: "Answer entry ID.", cardinality: "high" },
	},
} as const;

/** Durable's content-free span, event, and metric vocabulary. IDs address durable records, never content. */
export const DURABLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"pi.durable.submit": {
			description:
				"Public submission admission and its commit. Inputs start root traces linked to their callers; writes are children. Internal admissions emit phase events only.",
			parents: { kind: "any" },
			startAttributes: {
				"submission.type": {
					type: "string",
					required: true,
					values: ["input", "write"],
					description: "Submission type.",
				},
				"conversation.id": { type: "number", required: true, description: "Conversation ID.", cardinality: "high" },
			},
			endAttributes: {
				"submission.id": { type: "number", description: "Admitted submission ID.", cardinality: "high" },
				result: {
					type: "string",
					values: ["queued", "placed", "done"],
					description: "Admission result; stale writes report done.",
				},
			},
			events: { "pi.durable.entry": entry, "pi.durable.submission": submission, "pi.durable.report": report },
			status: { default: "ok", errorWhen: "Admission failed." },
		},
		"pi.durable.phase": {
			description: "One task phase invocation, including its decision commit, never a wait or restart.",
			parents: { kind: "any" },
			startAttributes: {
				"task.id": { type: "number", required: true, description: "Task ID.", cardinality: "high" },
				"task.name": { type: "string", required: true, description: "Registered task name." },
				phase: { type: "string", required: true, description: "Invoked checkpoint phase." },
				kind: { type: "string", required: true, values: ["run", "abort"], description: "Invocation kind." },
				attempt: { type: "number", required: false, description: "Checkpoint attempt, when present." },
				resumed: {
					type: "boolean",
					required: true,
					description: "First invocation of a task loaded in this process.",
				},
			},
			endAttributes: {
				outcome: { type: "string", description: "next=<phase>, waiting, sleeping, done, faulted, or aborted." },
				"tool.name": { type: "string", description: "Called tool name." },
				"tool.call_id": { type: "string", description: "Transcript tool call ID.", cardinality: "high" },
			},
			events: {
				"pi.durable.entry": entry,
				"pi.durable.submission": submission,
				"pi.durable.report": report,
				"pi.durable.checkpoint": {
					description: "The running checkpoint's phase changed while the invocation continued.",
					attributes: { phase: { type: "string", required: true, description: "Committed checkpoint phase." } },
				},
				"pi.durable.replay": {
					description: "A nested tool call was answered from its stored result.",
					attributes: { "tool.name": { type: "string", required: true, description: "Called tool name." } },
				},
			},
			status: {
				default: "ok",
				errorWhen:
					"Faulted, failed, and orphaned outcomes use task_faulted, task_failed, and task_orphaned with a diagnostic capped at 500 characters. Aborted outcomes keep status ok.",
			},
		},
	},
	metrics: {
		"pi.durable.reports": {
			kind: "counter",
			description: "Reports raised, grouped by their fixed ReportInfo type.",
			attributes: { type: reportAttributes.type },
		},
		"pi.durable.phase.duration": {
			kind: "histogram",
			unit: "ms",
			description: "Duration of a phase invocation and its decision commit.",
			attributes: {
				task: { type: "string", required: true, description: "Registered task name." },
				phase: { type: "string", required: true, description: "Invoked checkpoint phase." },
				outcome: { type: "string", required: true, description: "Phase outcome." },
			},
		},
		"pi.durable.tasks.active": {
			kind: "upDownCounter",
			description: "Live tasks held by this Harness; decremented at terminal settlement or close.",
			attributes: { task: { type: "string", required: true, description: "Registered task name." } },
		},
	},
});

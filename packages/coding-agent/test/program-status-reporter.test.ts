import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";

function setup(sessionName?: string) {
	const reports: ProgramStatus[] = [];
	const terminal = { setProgramStatus: (status: ProgramStatus) => reports.push(status) } as unknown as Terminal;
	const session = { name: sessionName };
	const reporter = new ProgramStatusReporter(
		() => terminal,
		() => session.name,
	);
	const send = (...events: AgentSessionEvent[]) => {
		for (const event of events) reporter.handleEvent(event);
	};
	const last = () => {
		const { app: _app, ...status } = reports.at(-1)!;
		return Object.fromEntries(Object.entries(status).filter(([, value]) => value !== undefined));
	};
	return { reporter, reports, session, send, last };
}

function assistantEnd(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AgentSessionEvent {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "secret assistant output" }],
		stopReason,
		errorMessage,
	} as AssistantMessage;
	return { type: "message_end", message };
}

const settled: AgentSessionEvent = { type: "agent_settled", aborted: false };

const compactionEnd = (
	reason: "manual" | "threshold" | "overflow",
	options: { aborted?: boolean; errorMessage?: string } = {},
): AgentSessionEvent => ({
	type: "compaction_end",
	reason,
	result: undefined,
	aborted: options.aborted ?? false,
	willRetry: false,
	errorMessage: options.errorMessage,
});

// #10607
describe("ProgramStatusReporter", () => {
	it("reports idle, working during a run, and done once it settles", () => {
		const { reporter, reports, send, last } = setup("Fix login");
		reporter.report();
		expect(reports.at(-1)).toEqual({ state: "idle", app: "pi" });

		send({ type: "agent_start" });
		expect(last()).toEqual({ state: "working", message: "Fix login" });

		send(assistantEnd("toolUse"), assistantEnd("stop"));
		expect(last()).toEqual({ state: "working", message: "Fix login" });

		send(settled);
		expect(last()).toEqual({ state: "done", message: "Fix login" });
		expect(JSON.stringify(reports)).not.toContain("secret assistant output");
	});

	it("reports only the outcome of the run: retried errors, final errors, and aborts", () => {
		const { send, last } = setup();
		send({ type: "agent_start" }, assistantEnd("error", "overloaded"), assistantEnd("stop"), settled);
		expect(last()).toEqual({ state: "done" });

		send({ type: "agent_start" }, assistantEnd("error", "Invalid API key\n{details}"), settled);
		expect(last()).toEqual({ state: "error", message: "Invalid API key" });

		send({ type: "agent_start" }, assistantEnd("aborted"), { type: "agent_settled", aborted: true });
		expect(last()).toEqual({ state: "idle" });

		// Aborted after a successful response, for example in an agent_before_settle hook or a retry delay.
		send({ type: "agent_start" }, assistantEnd("stop"), { type: "agent_settled", aborted: true });
		expect(last()).toEqual({ state: "idle" });
	});

	it("reports a failed recovery compaction as the run's error unless a later response succeeds", () => {
		const { send, last } = setup();
		send(
			{ type: "agent_start" },
			assistantEnd("length"),
			{ type: "compaction_start", reason: "overflow" },
			compactionEnd("overflow", { errorMessage: "Compaction failed\nstack" }),
			settled,
		);
		expect(last()).toEqual({ state: "error", message: "Compaction failed" });

		send(
			{ type: "agent_start" },
			{ type: "compaction_start", reason: "threshold" },
			compactionEnd("threshold", { errorMessage: "Compaction failed" }),
			assistantEnd("stop"),
			settled,
		);
		expect(last()).toEqual({ state: "done" });
	});

	it("reports compaction inside a run and the result of a manual compaction", () => {
		const { send, last } = setup("Session");
		send({ type: "agent_start" }, { type: "compaction_start", reason: "threshold" });
		expect(last()).toEqual({ state: "working", message: "Compacting context" });
		send(compactionEnd("threshold"));
		expect(last()).toEqual({ state: "working", message: "Session" });
		send(assistantEnd("stop"), settled);

		send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual"));
		expect(last()).toEqual({ state: "done", message: "Session" });
		send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual", { errorMessage: "No model" }));
		expect(last()).toEqual({ state: "error", message: "No model" });
		send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual", { aborted: true }));
		expect(last()).toEqual({ state: "idle" });
	});

	it("reports the most recent open dialog and the underlying state once all close", () => {
		const { reporter, send, last } = setup();
		send({ type: "agent_start" });
		reporter.setBlocked("extension-selector", { kind: "permission", message: "Allow bash?" });
		reporter.setBlocked("login", { kind: "auth", message: "Log in to Anthropic" });
		expect(last()).toEqual({ state: "blocked", kind: "auth", message: "Log in to Anthropic" });

		// The run settles while the selector is still open.
		reporter.setBlocked("login", undefined);
		send(assistantEnd("stop"), settled);
		expect(last()).toEqual({ state: "blocked", kind: "permission", message: "Allow bash?" });

		// Reopening a source replaces its dialog instead of stacking a second one.
		reporter.setBlocked("extension-selector", { kind: "question", message: "Pick one" });
		expect(last()).toEqual({ state: "blocked", kind: "question", message: "Pick one" });
		reporter.setBlocked("extension-selector", undefined);
		expect(last()).toEqual({ state: "done" });
	});

	it("sends each status once and follows session name changes", () => {
		const { reporter, reports, session, send, last } = setup("Old");
		send({ type: "agent_start" }, { type: "turn_start" } as AgentSessionEvent, assistantEnd("toolUse"));
		reporter.report();
		expect(reports).toHaveLength(1);

		session.name = "New";
		send({ type: "session_info_changed", name: "New" });
		expect(last()).toEqual({ state: "working", message: "New" });
	});

	it("returns to idle when the session is replaced", () => {
		const { reporter, send, last } = setup();
		send({ type: "agent_start" }, assistantEnd("stop"), settled);
		reporter.reset();
		expect(last()).toEqual({ state: "idle" });
	});
});

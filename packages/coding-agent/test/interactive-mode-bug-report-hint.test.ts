import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { formatCrashExtensionHint, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type BugReportHintContext = {
	suggestBugReport(): void;
	maybeShowInstallChangeWarning(): boolean;
};

const maybeSuggestBugReport = Reflect.get(InteractiveMode.prototype, "maybeSuggestBugReport") as (
	this: BugReportHintContext,
	message: AssistantMessage,
) => void;

function errorMessage(errorMessage: string): AssistantMessage {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

describe("InteractiveMode bug report hints", () => {
	test("identifies extensions with frames in a crash stack", () => {
		expect(formatCrashExtensionHint(["npm:pi-observational-memory"])).toBe(
			"A stack frame came from loaded extension `npm:pi-observational-memory`, which may be involved. Try disabling it with `pi config`, or run `pi -ne` to confirm.",
		);
		expect(formatCrashExtensionHint(undefined)).toBeUndefined();
	});

	test("does not suggest reports for retryable provider failures", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };
		const failures = [
			"500 Internal Server Error",
			"502 Bad Gateway",
			"503 Service Unavailable",
			"504 Gateway Timeout",
			"429 Too Many Requests",
			"Provider overloaded",
			"Network connection lost",
			"Request timed out",
		];

		for (const failure of failures) maybeSuggestBugReport.call(context, errorMessage(failure));

		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	test("does not suggest reports for cancellations", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };

		maybeSuggestBugReport.call(context, errorMessage("This operation was aborted"));
		maybeSuggestBugReport.call(context, errorMessage("Request cancelled"));
		maybeSuggestBugReport.call(context, fauxAssistantMessage("", { stopReason: "aborted" }));

		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	test("suggests reports for unexpected errors", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };

		maybeSuggestBugReport.call(context, errorMessage("Unexpected internal state"));

		expect(context.suggestBugReport).toHaveBeenCalledOnce();
	});

	test("shows the install change warning instead of a bug report hint", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => true) };

		maybeSuggestBugReport.call(context, errorMessage("Cannot find module './worker.js'"));

		expect(context.maybeShowInstallChangeWarning).toHaveBeenCalledOnce();
		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});
});

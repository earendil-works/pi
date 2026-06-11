import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number, extensionStatuses?: Map<string, string>): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses ?? new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent mode chip", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows Agent mode chip by default (no plan-mode extension)", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(80);
		// Should have 3 lines: pwd, stats, mode chip
		expect(lines.length).toBe(3);
		// Third line should contain "Agent"
		expect(lines[2]).toContain("Agent");
	});

	it("shows Plan mode chip when plan-mode extension is active", () => {
		const session = createSession({ sessionName: "" });
		const extensionStatuses = new Map<string, string>();
		extensionStatuses.set("plan-mode", "⏸ plan");
		const footer = new FooterComponent(session, createFooterData(1, extensionStatuses));

		const lines = footer.render(80);
		// Should have 3 lines: pwd, stats, mode chip (plan-mode removed from extension statuses)
		expect(lines.length).toBe(3);
		// Third line should contain "Plan"
		expect(lines[2]).toContain("Plan");
	});

	it("shows Plan mode chip with warning color", () => {
		const session = createSession({ sessionName: "" });
		const extensionStatuses = new Map<string, string>();
		extensionStatuses.set("plan-mode", "⏸ plan");
		const footer = new FooterComponent(session, createFooterData(1, extensionStatuses));

		const lines = footer.render(80);
		// Find the line containing "Plan"
		const planLine = lines.find((line) => line.includes("Plan"));
		expect(planLine).toBeDefined();
		// Check that it contains ANSI color codes for warning (amber)
		// Warning color should be present in the ANSI escape sequence
		expect(planLine).toMatch(/\x1b\[38;/);
	});

	it("shows Agent mode chip with accent color", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(80);
		// Find the line containing "Agent"
		const agentLine = lines.find((line) => line.includes("Agent"));
		expect(agentLine).toBeDefined();
		// Check that it contains ANSI color codes for accent (blue)
		expect(agentLine).toMatch(/\x1b\[38;/);
	});

	it("removes plan-mode from extension statuses to avoid duplication", () => {
		const session = createSession({ sessionName: "" });
		const extensionStatuses = new Map<string, string>();
		extensionStatuses.set("plan-mode", "⏸ plan");
		extensionStatuses.set("other-status", "some status");
		const footer = new FooterComponent(session, createFooterData(1, extensionStatuses));

		const lines = footer.render(80);
		// The extension status line should only contain "some status", not "⏸ plan"
		const statusLine = lines.find((line) => line.includes("some status"));
		expect(statusLine).toBeDefined();
		expect(statusLine).not.toContain("⏸ plan");
	});

	it("keeps mode chip within terminal width", () => {
		const session = createSession({ sessionName: "" });
		const extensionStatuses = new Map<string, string>();
		extensionStatuses.set("plan-mode", "⏸ plan");
		const footer = new FooterComponent(session, createFooterData(1, extensionStatuses));

		const width = 40;
		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows mode chip even when no extension statuses exist", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(80);
		// Should have 3 lines: pwd, stats, mode chip
		expect(lines.length).toBe(3);
		// Third line should be the mode chip
		expect(lines[2]).toContain("Agent");
	});

	it("shows mode chip before other extension statuses", () => {
		const session = createSession({ sessionName: "" });
		const extensionStatuses = new Map<string, string>();
		extensionStatuses.set("plan-mode", "⏸ plan");
		extensionStatuses.set("aaa-status", "first status");
		const footer = new FooterComponent(session, createFooterData(1, extensionStatuses));

		const lines = footer.render(80);
		// The mode chip should be on its own line, before the extension status line
		// Find lines containing "Plan" and "first status"
		const planLineIndex = lines.findIndex((line) => line.includes("Plan"));
		const statusLineIndex = lines.findIndex((line) => line.includes("first status"));

		// Plan should come before other statuses
		expect(planLineIndex).toBeLessThan(statusLineIndex);
	});
});

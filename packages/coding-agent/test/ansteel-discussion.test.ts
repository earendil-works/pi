import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnsteelConfig,
	type AnsteelDiscussionStage,
	AnsteelGovernanceSetupError,
	type AnsteelRole,
	createAnsteelRawTurnSession,
	createAnsteelSetupFailureMarkdown,
	createAnsteelToolBudget,
	getAnsteelReviewExitCode,
	loadAnsteelConfig,
	runAnsteelDiscussion,
	runAnsteelProjectReview,
	writeAnsteelReport,
} from "../src/core/ansteel-discussion.ts";

type RawTurnMessage = {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
};

type RawTurnSessionSource = {
	readonly messages: readonly RawTurnMessage[];
	prompt: (text: string) => Promise<void>;
	subscribeToAssistantMessageEnd: (listener: (message: unknown) => void) => () => void;
	subscribeToAgentEvent?: (listener: (event: unknown) => void) => () => void;
	abort?: () => void | Promise<void>;
	dispose: () => void | Promise<void>;
};

function createAssistantMessageEmitter(): {
	emit: (message: RawTurnMessage) => void;
	subscribe: (listener: (message: unknown) => void) => () => void;
} {
	const listeners = new Set<(message: unknown) => void>();
	return {
		emit: (message) => {
			for (const listener of listeners) listener(message);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function createAgentEventEmitter(): {
	emit: (event: unknown) => void;
	subscribe: (listener: (event: unknown) => void) => () => void;
} {
	const listeners = new Set<(event: unknown) => void>();
	return {
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function getLegacyCopyText(messages: readonly RawTurnMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((message) => {
			if (message.role !== "assistant") return false;
			return !(message.stopReason === "aborted" && !message.content?.length);
		});
	if (!lastAssistant) return undefined;

	const text = (lastAssistant.content ?? [])
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("");
	return text.trim() || undefined;
}

const MUTUAL_REVIEW_STAGE_ORDER: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [
	{ role: "tech-lead", stage: "architecture" },
	{ role: "staff-engineer", stage: "staff-critique" },
	{ role: "qa-engineer", stage: "qa-critique" },
	{ role: "tech-lead", stage: "architecture-revision" },
	{ role: "staff-engineer", stage: "staff-verification" },
	{ role: "qa-engineer", stage: "qa-verification" },
	{ role: "tech-lead", stage: "consensus" },
	{ role: "staff-engineer", stage: "staff-sign-off" },
	{ role: "qa-engineer", stage: "qa-sign-off" },
];

const MUTUAL_REVIEW_RESPONSES: Record<AnsteelDiscussionStage, string> = {
	architecture: "[L1] Architecture v0",
	"staff-critique": "ISSUE: STAFF-INITIAL\n[L2] Initial implementation concern",
	"qa-critique": "ISSUE: QA-INITIAL\n[L2] Initial testability concern",
	"architecture-revision": "RESOLUTION: STAFF-INITIAL | RESOLVED\nRESOLUTION: QA-INITIAL | RESOLVED",
	"staff-verification": "VERDICT: APPROVE",
	"qa-verification": "VERDICT: APPROVE",
	consensus: "[L1] Immutable consensus",
	"staff-sign-off": "VERDICT: APPROVE",
	"qa-sign-off": "VERDICT: APPROVE",
};

function getStageFromPrompt(prompt: string): AnsteelDiscussionStage {
	const match = /Current stage: ([a-z-]+)\./.exec(prompt);
	if (!match || !(match[1] in MUTUAL_REVIEW_RESPONSES)) {
		throw new Error(`Could not determine Ansteel stage from prompt: ${prompt}`);
	}
	return match[1] as AnsteelDiscussionStage;
}

function responseForMutualReviewStage(
	stage: AnsteelDiscussionStage,
	overrides: Partial<Record<AnsteelDiscussionStage, string>> = {},
): string {
	return overrides[stage] ?? MUTUAL_REVIEW_RESPONSES[stage];
}

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

describe("runAnsteelDiscussion", () => {
	it("bounds each role stage to a finite number of safe tool executions", () => {
		const budget = createAnsteelToolBudget(2);

		expect(budget.beforeToolCall("read", { path: "src/main.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("find", { pattern: "*.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("grep", { pattern: "TODO" })).toEqual({
			block: true,
			reason:
				"Ansteel stage tool budget of 2 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		});
		expect(budget.getStageFailureReason()).toBe(
			"Ansteel stage tool budget of 2 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		);

		budget.reset();
		expect(budget.beforeToolCall("bash", { command: "npm test" })).toEqual({
			block: true,
			reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
		});
		expect(budget.getStageFailureReason()).toBe("Ansteel bash requires an explicit timeout of at most 20 seconds.");
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 21 })).toEqual({
			block: true,
			reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
		});
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 20 })).toEqual({
			block: true,
			reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
		});

		budget.reset();
		expect(budget.getStageFailureReason()).toBeUndefined();
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 20 })).toBeUndefined();
	});

	it("reads only the raw assistant text created by the current prompt", async () => {
		const messages: RawTurnMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "VERDICT: APPROVE" }],
				stopReason: "stop",
			},
		];
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages,
			prompt: async () => {
				const response: RawTurnMessage = {
					role: "assistant",
					content: [
						{ type: "text", text: "VERDICT: " },
						{ type: "text", text: "APPROVE " },
					],
					stopReason: "stop",
				};
				messages.push(response);
				assistantMessages.emit(response);
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const session = createAnsteelRawTurnSession(source);

		const response = await session.prompt("veto");

		expect(getLegacyCopyText(messages)).toBe("VERDICT: APPROVE");
		expect(response).toBe("VERDICT: APPROVE ");
	});

	it("forwards the raw session abort hook", async () => {
		let aborts = 0;
		const session = createAnsteelRawTurnSession({
			prompt: async () => {},
			subscribeToAssistantMessageEnd: () => () => {},
			abort: () => {
				aborts++;
			},
			dispose: () => {},
		});

		expect(session.abort).toBeDefined();
		await session.abort?.();
		expect(aborts).toBe(1);
	});

	it("captures the current assistant event when compaction replaces the message list", async () => {
		let messages: RawTurnMessage[] = [
			{ role: "user", content: [{ type: "text", text: "old request" }] },
			{ role: "assistant", content: [{ type: "text", text: "old response" }] },
		];
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			get messages() {
				return messages;
			},
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Current evidence before compaction" }],
				});
				messages = [{ role: "assistant", content: [{ type: "text", text: "compacted history" }] }];
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("verify evidence");

		expect(response).toBe("[L1] Current evidence before compaction");
	});

	it("uses the final assistant message emitted during a prompt", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages: [],
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L3] First tool-loop response" }],
				});
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Final verified response " }],
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("verify evidence");

		expect(response).toBe("[L1] Final verified response ");
	});

	it("records a stage audit trail with tool lifecycle events", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const agentEvents = createAgentEventEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				agentEvents.emit({
					type: "tool_execution_start",
					toolCallId: "read-1",
					toolName: "read",
					args: { path: "src/main.ts" },
				});
				agentEvents.emit({
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [] },
					isError: false,
				});
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Evidence reviewed" }],
					stopReason: "stop",
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			subscribeToAgentEvent: agentEvents.subscribe,
			dispose: () => {},
		});

		await session.prompt("review evidence");

		const auditableSession = session as typeof session & {
			getLastStageAudit?: () => { events: Array<Record<string, unknown>> };
		};
		expect(auditableSession.getLastStageAudit?.()).toEqual({
			events: [
				expect.objectContaining({ type: "stage-prompt-start" }),
				expect.objectContaining({ type: "tool-execution-start", toolName: "read" }),
				expect.objectContaining({ type: "tool-execution-end", toolName: "read", isError: false }),
				expect.objectContaining({ type: "assistant-message-end", stopReason: "stop" }),
				expect.objectContaining({ type: "stage-prompt-end" }),
			],
		});
	});

	it("does not reuse an older assistant message when no current assistant event is emitted", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "VERDICT: APPROVE" }] }],
			prompt: async () => {},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("veto");

		expect(response).toBe("");
	});

	it("surfaces a redacted provider error instead of treating it as an empty role reply", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Provider rejected Authorization: Bearer top-secret-token",
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		});

		await expect(session.prompt("inspect failure")).rejects.toThrow(
			"Ansteel role provider error: Provider rejected Authorization: Bearer [REDACTED]",
		);
		const audit = session.getLastStageAudit?.();
		expect(audit?.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "assistant-message-end", stopReason: "error" }),
				expect.objectContaining({ type: "stage-prompt-error" }),
			]),
		);
		expect(audit?.events).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "stage-prompt-end" })]),
		);
	});

	it("attempts every raw-session listener cleanup after one cleanup fails", async () => {
		let agentEventUnsubscribes = 0;
		const assistantMessages = createAssistantMessageEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Evidence" }],
					stopReason: "stop",
				});
			},
			subscribeToAssistantMessageEnd: (listener) => {
				const unsubscribe = assistantMessages.subscribe(listener);
				return () => {
					unsubscribe();
					throw new Error("assistant listener cleanup failed");
				};
			},
			subscribeToAgentEvent: () => () => {
				agentEventUnsubscribes++;
			},
			dispose: () => {},
		});

		await expect(session.prompt("verify cleanup")).rejects.toThrow("assistant listener cleanup failed");
		expect(agentEventUnsubscribes).toBe(1);
	});

	it("redacts thrown role failures before they reach the discussion report", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Redact provider failure",
			runRole: async () => {
				throw new Error("Provider rejected Authorization: Bearer sk-unit-test-provider-secret");
			},
		});

		expect(result.failure?.reason).toBe("Provider rejected Authorization: Bearer [REDACTED]");
		expect(result.markdown).toContain("Bearer [REDACTED]");
		expect(result.markdown).not.toContain("sk-unit-test-provider-secret");
	});

	it("unsubscribes a failed prompt listener before a later stage emits an assistant message", async () => {
		const listeners = new Set<(message: unknown) => void>();
		const deliveryCounts = new Map<number, number>();
		let promptCount = 0;
		let subscriptionCount = 0;
		let unsubscribeCalls = 0;
		const emitAssistantMessage = (message: RawTurnMessage): void => {
			for (const listener of listeners) listener(message);
		};
		const source: RawTurnSessionSource = {
			messages: [],
			prompt: async () => {
				promptCount++;
				if (promptCount === 1) throw new Error("source prompt failed");
				emitAssistantMessage({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Later-stage evidence" }],
				});
			},
			subscribeToAssistantMessageEnd: (listener) => {
				const subscription = subscriptionCount++;
				deliveryCounts.set(subscription, 0);
				const trackedListener = (message: unknown): void => {
					deliveryCounts.set(subscription, (deliveryCounts.get(subscription) ?? 0) + 1);
					listener(message);
				};
				listeners.add(trackedListener);
				return () => {
					unsubscribeCalls++;
					listeners.delete(trackedListener);
				};
			},
			dispose: () => {},
		};

		const session = createAnsteelRawTurnSession(source);

		await expect(session.prompt("failed stage")).rejects.toThrow("source prompt failed");
		expect(await session.prompt("later stage")).toBe("[L1] Later-stage evidence");
		expect(unsubscribeCalls).toBe(2);
		expect(listeners.size).toBe(0);
		expect(deliveryCounts.get(0)).toBe(0);
		expect(deliveryCounts.get(1)).toBe(1);
	});

	it("keeps the provider failure primary when raw listener cleanup also fails", async () => {
		type TestModel = { provider: string; id: string };
		const promptedRoles: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a raw provider failure",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				if (role === "tech-lead") {
					return createAnsteelRawTurnSession({
						prompt: async () => {
							promptedRoles.push(role);
							throw new Error("provider request failed");
						},
						subscribeToAssistantMessageEnd: () => () => {
							throw new Error("listener cleanup failed");
						},
						dispose: () => {
							disposed.push(role);
						},
					});
				}

				return {
					prompt: async () => {
						promptedRoles.push(role);
						throw new Error(`Unexpected prompt for ${role}`);
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "tech-lead",
			stage: "architecture",
			reason: "provider request failed; listener cleanup also failed: listener cleanup failed",
		});
		expect(result.transcript).toEqual([]);
		expect(promptedRoles).toEqual(["tech-lead"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("rejects and archives listener cleanup failure after a successful raw prompt", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review listener cleanup failure",
			runRole: async ({ role, stage, prompt }) => {
				if (role !== "tech-lead" || stage !== "architecture") {
					throw new Error(`Unexpected ${role} / ${stage}`);
				}

				return await createAnsteelRawTurnSession({
					prompt: async () => {},
					subscribeToAssistantMessageEnd: () => () => {
						throw new Error("listener cleanup failed");
					},
					dispose: () => {},
				}).prompt(prompt);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "tech-lead",
			stage: "architecture",
			reason: "listener cleanup failed",
		});
		expect(result.transcript).toEqual([]);
		expect(result.markdown).toContain("- Reason: listener cleanup failed");
	});

	it("stops project review when the current QA reply is empty instead of reusing an earlier reply", async () => {
		type TestModel = { provider: string; id: string };
		const prompts: Array<{ role: AnsteelRole; text: string }> = [];
		let qaMessages: RawTurnMessage[] | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review current QA turn",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				const assistantMessages = createAssistantMessageEmitter();
				const messages: RawTurnMessage[] =
					role === "qa-engineer"
						? [
								{
									role: "assistant",
									content: [{ type: "text", text: "VERDICT: APPROVE" }],
									stopReason: "stop",
								},
							]
						: [];
				if (role === "qa-engineer") qaMessages = messages;
				return createAnsteelRawTurnSession({
					prompt: async (text) => {
						prompts.push({ role, text });
						const stage = getStageFromPrompt(text);
						const response: RawTurnMessage =
							stage === "qa-verification"
								? { role: "assistant", content: [], stopReason: "aborted" }
								: { role: "assistant", content: [{ type: "text", text: responseForMutualReviewStage(stage) }] };
						messages.push(response);
						assistantMessages.emit(response);
					},
					subscribeToAssistantMessageEnd: assistantMessages.subscribe,
					dispose: () => {},
				});
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe("");
		expect(getLegacyCopyText(qaMessages ?? [])).toBe("ISSUE: QA-INITIAL\n[L2] Initial testability concern");
		expect(result.markdown).toContain("qa-engineer / qa-verification returned an empty or whitespace-only response");
		expect(prompts.some(({ text }) => text.includes("Current stage: consensus."))).toBe(false);
	});

	it("routes one architecture through independent Staff and QA challenges before consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string; prompt: string }> = [];
		const architecture = "[L1] Architecture v0: component boundaries, failure policy, and acceptance criteria";

		const result = await runAnsteelDiscussion({
			topic: "Review the motor safety architecture",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				switch (stage) {
					case "architecture":
						return architecture;
					case "staff-critique":
						return "ISSUE: STAFF-1\n[L2] The driver interface cannot meet the proposed timing.";
					case "qa-critique":
						return "ISSUE: QA-1\n[L2] The fault-injection acceptance test is missing.";
					case "architecture-revision":
						return "RESOLUTION: STAFF-1 | RESOLVED\nRESOLUTION: QA-1 | RESOLVED";
					case "staff-verification":
						return "VERDICT: APPROVE\nSTAFF-VERIFICATION-PRIVATE";
					case "qa-verification":
						return "VERDICT: APPROVE\nQA-VERIFICATION-PRIVATE";
					case "staff-sign-off":
					case "qa-sign-off":
						return "VERDICT: APPROVE";
					case "consensus":
						return "[L1] Immutable architecture consensus";
					default:
						return `[L2] ${role}/${stage}`;
				}
			},
		});

		expect(result.verdict).toBe("approved");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toEqual([
			"tech-lead:architecture",
			"staff-engineer:staff-critique",
			"qa-engineer:qa-critique",
			"tech-lead:architecture-revision",
			"staff-engineer:staff-verification",
			"qa-engineer:qa-verification",
			"tech-lead:consensus",
			"staff-engineer:staff-sign-off",
			"qa-engineer:qa-sign-off",
		]);

		const staffCritiquePrompt = calls.find((call) => call.stage === "staff-critique")?.prompt ?? "";
		const qaCritiquePrompt = calls.find((call) => call.stage === "qa-critique")?.prompt ?? "";
		const architectureRevisionPrompt = calls.find((call) => call.stage === "architecture-revision")?.prompt ?? "";
		const staffVerificationPrompt = calls.find((call) => call.stage === "staff-verification")?.prompt ?? "";
		const qaVerificationPrompt = calls.find((call) => call.stage === "qa-verification")?.prompt ?? "";
		expect(staffCritiquePrompt).toContain(architecture);
		expect(qaCritiquePrompt).toContain(architecture);
		expect(staffCritiquePrompt).not.toContain("The fault-injection acceptance test is missing.");
		expect(qaCritiquePrompt).not.toContain("The driver interface cannot meet the proposed timing.");
		expect(architectureRevisionPrompt).toContain("The driver interface cannot meet the proposed timing.");
		expect(architectureRevisionPrompt).toContain("The fault-injection acceptance test is missing.");
		for (const verificationPrompt of [staffVerificationPrompt, qaVerificationPrompt]) {
			expect(verificationPrompt).toContain("RESOLUTION: STAFF-1 | RESOLVED");
			expect(verificationPrompt).toContain("RESOLUTION: QA-1 | RESOLVED");
			expect(verificationPrompt).toContain("STAFF-1 | staff-engineer | round 0 | resolved");
			expect(verificationPrompt).toContain("QA-1 | qa-engineer | round 0 | resolved");
		}
		expect(qaVerificationPrompt).not.toContain("STAFF-VERIFICATION-PRIVATE");
	});

	it("returns verifier rejections to a second architecture revision before rejecting at the cap", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string }> = [];
		let revisionCount = 0;

		const result = await runAnsteelDiscussion({
			topic: "Review repeated architecture objections",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				switch (stage) {
					case "architecture":
						return "[L1] Architecture v0";
					case "staff-critique":
						return "ISSUE: STAFF-INITIAL\n[L2] Initial implementation objection";
					case "qa-critique":
						return "ISSUE: QA-INITIAL\n[L2] Initial testability objection";
					case "architecture-revision":
						revisionCount++;
						return revisionCount === 1
							? ["RESOLUTION: STAFF-INITIAL | RESOLVED", "RESOLUTION: QA-INITIAL | RESOLVED"].join("\n")
							: [
									`RESOLUTION: STAFF-VERIFY-${revisionCount - 1} | RESOLVED`,
									`RESOLUTION: QA-VERIFY-${revisionCount - 1} | RESOLVED`,
								].join("\n");
					case "staff-verification":
						return `VERDICT: REJECT\nISSUE: STAFF-VERIFY-${revisionCount}\n[L1] The implementation still cannot meet the timing bound.`;
					case "qa-verification":
						return `VERDICT: REJECT\nISSUE: QA-VERIFY-${revisionCount}\n[L1] The safety test still cannot prove the fault path.`;
					default:
						return `[L2] ${role}/${stage}`;
				}
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(calls.filter((call) => call.stage === "architecture-revision")).toHaveLength(2);
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
		expect(result.markdown).toContain("maximum of 2 architecture revision rounds");
	});

	it("rejects an architecture revision that does not answer every challenge ID", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review unresolved architecture challenge",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				switch (stage) {
					case "architecture":
						return "[L1] Architecture v0";
					case "staff-critique":
						return "ISSUE: STAFF-UNANSWERED\n[L2] Driver ownership is ambiguous.";
					case "qa-critique":
						return "ISSUE: QA-ANSWERED\n[L2] Error-path coverage is incomplete.";
					case "architecture-revision":
						return "RESOLUTION: QA-ANSWERED | RESOLVED";
					default:
						return `[L2] ${role}/${stage}`;
				}
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.markdown).toContain("STAFF-UNANSWERED");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("staff-engineer:staff-verification");
	});

	it("allows independent reviewers to record NO ISSUES", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review an architecture without objections",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"staff-critique": "NO ISSUES",
					"qa-critique": "NO ISSUES",
					"architecture-revision": "[L1] Architecture v1 remains unchanged after independent review.",
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([]);
		expect(result.markdown).toContain("No recorded challenge IDs.");
	});

	it.each([
		["a trailing space on an issue marker", "ISSUE: STAFF-STRICT "],
		["a trailing space on the no-issues marker", "NO ISSUES "],
	])("rejects %s before the architecture revision", async (_description, staffCritique) => {
		const result = await runAnsteelDiscussion({
			topic: "Review strict challenge marker parsing",
			runRole: async ({ stage }) =>
				stage === "staff-critique" ? staffCritique : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("staff-critique");
	});

	it("rejects a resolution marker with trailing whitespace before verification", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review strict resolution marker parsing",
			runRole: async ({ stage }) =>
				stage === "architecture-revision"
					? "RESOLUTION: STAFF-INITIAL | RESOLVED \nRESOLUTION: QA-INITIAL | RESOLVED"
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("unanswered-challenge");
		expect(result.transcript.at(-1)?.stage).toBe("architecture-revision");
	});

	it("rejects a verification rejection that does not add a new issue", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review an unsupported verification rejection",
			runRole: async ({ stage }) =>
				stage === "qa-verification" ? "VERDICT: REJECT\nNO ISSUES" : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("qa-engineer rejected the architecture without adding a new ISSUE line");
	});

	it("returns a QA verification rejection to a second architecture revision before consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; round?: number }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review the motor safety change",
			runRole: async ({ role, stage, round }) => {
				calls.push({ role, stage, round });
				if (stage === "qa-verification" && round === 1) {
					return "VERDICT: REJECT\nISSUE: QA-VERIFICATION-1\n[L1] The safety test is absent.";
				}
				if (stage === "architecture-revision" && round === 2) {
					return "RESOLUTION: QA-VERIFICATION-1 | RESOLVED";
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.revisionRounds).toEqual([
			{ round: 1, staffVerdict: "approved", qaVerdict: "rejected", outcome: "needs-revision" },
			{ round: 2, staffVerdict: "approved", qaVerdict: "approved", outcome: "approved" },
		]);
		expect(
			calls.map(({ role, stage, round }) => `${role}:${stage}${round === undefined ? "" : `:${round}`}`),
		).toEqual([
			"tech-lead:architecture",
			"staff-engineer:staff-critique",
			"qa-engineer:qa-critique",
			"tech-lead:architecture-revision:1",
			"staff-engineer:staff-verification:1",
			"qa-engineer:qa-verification:1",
			"tech-lead:architecture-revision:2",
			"staff-engineer:staff-verification:2",
			"qa-engineer:qa-verification:2",
			"tech-lead:consensus",
			"staff-engineer:staff-sign-off",
			"qa-engineer:qa-sign-off",
		]);
		expect(result.markdown).toContain("QA-VERIFICATION-1");
	});

	it("runs consensus only after independent verification and keeps the discussion transcript", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review the parser",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					architecture: "[L1] Architecture boundary",
					"staff-critique": "ISSUE: STAFF-PARSER\n[L2] The implementation path is underspecified.",
					"qa-critique": "ISSUE: QA-PARSER\n[L3] The fault-path test still needs evidence.",
					"architecture-revision": "RESOLUTION: STAFF-PARSER | RESOLVED\nRESOLUTION: QA-PARSER | RESOLVED",
					"staff-verification": "VERDICT: APPROVE",
					"qa-verification":
						"[L2] Conditions met before the decision\nVERDICT: APPROVE\n[L2] Follow-up remains after the decision",
					consensus: "[L2] Consensus ",
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L2] Consensus ");
		expect(result.markdown).toContain("[L1] Architecture boundary");
		expect(result.markdown).toContain("STAFF-PARSER");
		expect(result.markdown).toContain("QA-PARSER");
		expect(result.markdown).toContain("## Tech Lead Consensus\n\n[L2] Consensus \n");
	});

	it("requires Staff and QA final sign-off on the immutable Tech Lead consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; prompt: string }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review final governance sign-off",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L1] Immutable consensus");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toEqual(
			MUTUAL_REVIEW_STAGE_ORDER.map(({ role, stage }) => `${role}:${stage}`),
		);
		for (const stage of ["staff-sign-off", "qa-sign-off"] as const) {
			const prompt = calls.find((call) => call.stage === stage)?.prompt ?? "";
			expect(prompt).toContain("[L1] Immutable consensus");
			expect(prompt).toContain("immutable");
		}
	});

	it.each([
		["Staff Engineer", "staff-engineer", "staff-sign-off", "VERDICT: APPROVE "],
		["QA Engineer", "qa-engineer", "qa-sign-off", "VERDICT: APPROVE "],
	] as const)(
		"rejects a non-exact final %s sign-off while preserving the consensus",
		async (_name, rejectedRole, rejectedStage, rejectedResponse) => {
			const calls: Array<{ role: AnsteelRole; stage: string }> = [];

			const result = await runAnsteelDiscussion({
				topic: "Review strict final governance sign-off",
				runRole: async ({ role, stage }) => {
					calls.push({ role, stage });
					if (role === rejectedRole && stage === rejectedStage) return rejectedResponse;
					return responseForMutualReviewStage(stage);
				},
			});

			expect(result.verdict).toBe("rejected");
			expect(result.consensus).toBe("[L1] Immutable consensus");
			expect(result.markdown).toContain("## Tech Lead Consensus\n\n[L1] Immutable consensus");
			expect(calls.at(-1)).toEqual({ role: rejectedRole, stage: rejectedStage });
		},
	);

	it("sends every role explicit L2-L4 confidence discipline", async () => {
		const prompts = new Map<AnsteelRole, string[]>();

		const result = await runAnsteelDiscussion({
			topic: "Review confidence discipline",
			runRole: async ({ role, stage, prompt }) => {
				const rolePrompts = prompts.get(role) ?? [];
				rolePrompts.push(prompt);
				prompts.set(role, rolePrompts);
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		for (const role of ["tech-lead", "staff-engineer", "qa-engineer"] as const) {
			const prompt = prompts.get(role)?.[0] ?? "";
			expect(prompt).toContain("L1 requires concrete evidence.");
			expect(prompt).toContain("L2 requires a stated technical basis.");
			expect(prompt).toContain("L3 requires a concrete verification method.");
			expect(prompt).toContain("L4 requires an explicit statement of what is unknown and no conclusion.");
		}
	});

	it.each([
		["a lower-case marker", "verdict: approve"],
		["a split-line marker", "VERDICT:\nAPPROVE"],
		["a missing verdict marker", "[L1] QA completed its review but omitted the required decision"],
		["a marker with trailing whitespace", "VERDICT: APPROVE "],
		["duplicate approval markers", "VERDICT: APPROVE\nVERDICT: APPROVE"],
		["contradictory markers", "VERDICT: APPROVE\nVERDICT: REJECT"],
		["a bullet-list contradiction", "VERDICT: APPROVE\n- VERDICT: REJECT"],
		["a Markdown-heading contradiction", "VERDICT: APPROVE\n## VERDICT: REJECT"],
		["an embedded contradictory verdict", "VERDICT: APPROVE\nThe audit says VERDICT: REJECT"],
		["a pending marker after approval", "VERDICT: APPROVE\nVERDICT PENDING"],
		["an isolated pending marker", "VERDICT PENDING"],
	])("rejects %s in QA verification without running consensus", async (_description, qaVerdict) => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review the QA gate",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				return stage === "qa-verification" ? qaVerdict : responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("invalid-verdict");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
	});

	it.each([
		["tech-lead", "architecture"],
		["staff-engineer", "staff-critique"],
		["qa-engineer", "qa-critique"],
		["tech-lead", "architecture-revision"],
		["staff-engineer", "staff-verification"],
		["qa-engineer", "qa-verification"],
		["tech-lead", "consensus"],
		["staff-engineer", "staff-sign-off"],
		["qa-engineer", "qa-sign-off"],
	] as const)(
		"rejects a whitespace-only %s / %s response without running later stages",
		async (blankRole, blankStage) => {
			const stageOrder = MUTUAL_REVIEW_STAGE_ORDER;
			const rawWhitespace = " \t \r\n";
			const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];
			const blankIndex = stageOrder.findIndex(({ role, stage }) => role === blankRole && stage === blankStage);

			const result = await runAnsteelDiscussion({
				topic: "Review empty role output",
				runRole: async ({ role, stage }) => {
					calls.push({ role, stage });
					if (role === blankRole && stage === blankStage) return rawWhitespace;
					return responseForMutualReviewStage(stage);
				},
			});

			expect(result.verdict).toBe("rejected");
			expect(result.consensus).toBe(
				blankIndex > stageOrder.findIndex(({ stage }) => stage === "consensus")
					? "[L1] Immutable consensus"
					: undefined,
			);
			expect(calls).toEqual(stageOrder.slice(0, blankIndex + 1));
			expect(result.transcript.at(-1)?.response).toBe(rawWhitespace);
			expect(result.markdown).toContain(
				`${blankRole} / ${blankStage} returned an empty or whitespace-only response`,
			);
			expect(result.markdown).toContain(rawWhitespace);
		},
	);

	it("archives a failed stage without inventing a role response or running later stages", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review a failed provider call",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				if (role === "staff-engineer" && stage === "staff-critique") {
					throw new Error("provider connection closed");
				}
				return "[L1] Architecture evidence ";
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "provider connection closed",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({ role: "tech-lead", stage: "architecture", response: "[L1] Architecture evidence " }),
		]);
		expect(calls).toEqual([
			{ role: "tech-lead", stage: "architecture" },
			{ role: "staff-engineer", stage: "staff-critique" },
		]);
		expect(result.markdown).toContain("## Stage Failure");
		expect(result.markdown).toContain("- Failed role: staff-engineer");
		expect(result.markdown).toContain("- Failed stage: staff-critique");
		expect(result.markdown).toContain("- Reason: provider connection closed");
	});

	it("archives a project-session prompt failure and disposes every created session", async () => {
		type TestModel = { provider: string; id: string };
		const prompts: Array<{ role: AnsteelRole; prompt: string }> = [];
		const created: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a failed role session",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				created.push(role);
				return {
					prompt: async (prompt) => {
						prompts.push({ role, prompt });
						if (role === "staff-engineer") throw new Error("role session timed out");
						return "[L1] Architecture evidence ";
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "role session timed out",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({ role: "tech-lead", stage: "architecture", response: "[L1] Architecture evidence " }),
		]);
		expect(prompts.map(({ role }) => role)).toEqual(["tech-lead", "staff-engineer"]);
		expect(prompts.some(({ prompt }) => prompt.includes("Current stage: consensus."))).toBe(false);
		expect(created).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("returns an auditable rejection when a project-stage prompt exceeds its timeout", async () => {
		type TestModel = { provider: string; id: string };
		const aborted: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];
		let rejectStaffPrompt: ((reason?: unknown) => void) | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a hung role session",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
				stageTimeoutMs: 20,
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				const session = {
					prompt: async () => {
						if (role === "staff-engineer") {
							return await new Promise<string>((_resolve, reject) => {
								rejectStaffPrompt = reject;
							});
						}
						return "[L1] Architecture evidence";
					},
					abort: () => {
						aborted.push(role);
						if (role === "staff-engineer") rejectStaffPrompt?.(new Error("session aborted after timeout"));
					},
					dispose: () => {
						disposed.push(role);
					},
					getLastStageAudit: () => ({
						events: [
							{ type: "stage-prompt-start" as const, elapsedMs: 0 },
							{ type: "tool-execution-start" as const, elapsedMs: 1, toolName: "find" },
						],
					}),
				};
				return session;
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("stage-timeout");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "Stage exceeded the configured timeout of 20ms",
			timeoutMs: 20,
		});
		expect(aborted).toEqual(["staff-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.markdown).toContain("- Termination reason: stage-timeout");
		expect(result.markdown).toContain("- Timeout: 20ms");
		expect(result.markdown).toContain("## Stage Audit Trail");
		expect(result.markdown).toContain("tool-execution-start: find");
		expect((result as typeof result & { stageAudits?: unknown }).stageAudits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "staff-engineer",
					stage: "staff-critique",
					events: expect.arrayContaining([expect.objectContaining({ toolName: "find" })]),
				}),
			]),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}, 1_000);

	it("archives timeout and abort events that arrive asynchronously", async () => {
		type TestModel = { provider: string; id: string };
		const staffAgentEvents = createAgentEventEmitter();
		const staffAssistantMessages = createAssistantMessageEmitter();
		let rejectStaffPrompt: ((reason?: unknown) => void) | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Archive timeout abort audit",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
				stageTimeoutMs: 20,
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				if (role !== "staff-engineer") {
					return { prompt: async () => "[L1] Architecture evidence", dispose: () => {} };
				}

				return createAnsteelRawTurnSession({
					prompt: async () =>
						await new Promise<void>((_resolve, reject) => {
							rejectStaffPrompt = reject;
						}),
					subscribeToAssistantMessageEnd: staffAssistantMessages.subscribe,
					subscribeToAgentEvent: staffAgentEvents.subscribe,
					abort: async () => {
						await Promise.resolve();
						staffAgentEvents.emit({
							type: "tool_execution_end",
							toolCallId: "abort-read",
							toolName: "read",
							isError: true,
						});
						staffAssistantMessages.emit({
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "aborted after timeout",
						});
						rejectStaffPrompt?.(new Error("session aborted after timeout"));
					},
					dispose: () => {},
				});
			},
		});

		const audit = result.stageAudits.find(
			(candidate) => candidate.role === "staff-engineer" && candidate.stage === "staff-critique",
		);
		expect(audit?.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "stage-timeout" }),
				expect.objectContaining({ type: "tool-execution-end", toolName: "read", isError: true }),
				expect.objectContaining({ type: "assistant-message-end", stopReason: "error" }),
			]),
		);
	});

	it("does not wait indefinitely for a timed-out role abort", async () => {
		type TestModel = { provider: string; id: string };
		let failTimeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				runAnsteelProjectReview<TestModel>({
					topic: "Bound a hung timeout abort",
					cwd: process.cwd(),
					config: {
						roles: {
							"tech-lead": { model: "tech/lead", tools: ["read"] },
							"staff-engineer": { model: "staff/engineer", tools: ["read"] },
							"qa-engineer": { model: "qa/engineer", tools: ["read"] },
						},
						reportDirectory: "unused",
						stageTimeoutMs: 20,
					},
					resolveModel: (provider, id) => ({ provider, id }),
					createRoleSession: async ({ role }) => ({
						prompt: async () => {
							if (role === "staff-engineer") return await new Promise<string>(() => {});
							return "[L1] Architecture evidence";
						},
						abort: () => {
							if (role === "staff-engineer") return new Promise<void>(() => {});
						},
						dispose: () => {},
					}),
				}),
				new Promise<never>((_resolve, reject) => {
					failTimeout = setTimeout(() => reject(new Error("Timed-out role abort was not bounded")), 1_000);
				}),
			]);

			expect(result.failure).toEqual({
				role: "staff-engineer",
				stage: "staff-critique",
				reason: "Stage exceeded the configured timeout of 20ms",
				timeoutMs: 20,
			});
		} finally {
			if (failTimeout) clearTimeout(failTimeout);
		}
	});

	it("preserves a rejected prompt failure when session cleanup also fails", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup after a failed role prompt",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async () => {
					if (role === "staff-engineer") throw new Error("role session timed out");
					return "[L1] Architecture evidence";
				},
				dispose: () => {
					disposed.push(role);
					if (role === "tech-lead") {
						throw new Error("tech-lead cleanup failed Authorization: Bearer sk-unit-test-cleanup-secret");
					}
					if (role === "staff-engineer") throw new Error("staff-engineer cleanup failed");
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "role session timed out",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({ role: "tech-lead", stage: "architecture", response: "[L1] Architecture evidence" }),
		]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.cleanupFailures).toEqual([
			{ role: "tech-lead", reason: "tech-lead cleanup failed Authorization: Bearer [REDACTED]" },
			{ role: "staff-engineer", reason: "staff-engineer cleanup failed" },
		]);
		expect(result.markdown).toContain("## Session Cleanup Failures");
		expect(result.markdown).toContain("- tech-lead: tech-lead cleanup failed Authorization: Bearer [REDACTED]");
		expect(result.markdown).not.toContain("sk-unit-test-cleanup-secret");
		expect(result.markdown).toContain("- staff-engineer: staff-engineer cleanup failed");
	});

	it("keeps a rejected review and completes cleanup when cleanup error formatting throws", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];
		const throwingCoercion = {
			toString: () => {
				throw new Error("cleanup coercion failed");
			},
		};
		const throwingMessageGetter = new Error("hidden cleanup failure");
		Object.defineProperty(throwingMessageGetter, "message", {
			configurable: true,
			get: () => {
				throw new Error("cleanup message getter failed");
			},
		});

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup error boundaries",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async () => {
					if (role === "staff-engineer") throw new Error("provider request failed");
					return "[L1] Architecture evidence";
				},
				dispose: () => {
					disposed.push(role);
					if (role === "tech-lead") throw throwingCoercion;
					if (role === "staff-engineer") throw throwingMessageGetter;
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "provider request failed",
		});
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.cleanupFailures).toEqual([
			{ role: "tech-lead", reason: "Unknown role failure" },
			{ role: "staff-engineer", reason: "Unknown role failure" },
		]);
		expect(result.markdown).toContain("## Session Cleanup Failures");
		expect(result.markdown).toContain("- tech-lead: Unknown role failure");
		expect(result.markdown).toContain("- staff-engineer: Unknown role failure");
	});

	it("preserves a role-session setup failure over cleanup failures", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review a role-session setup failure",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "tech/lead", tools: ["read"] },
						"staff-engineer": { model: "staff/engineer", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read"] },
					},
					reportDirectory: "unused",
				},
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async ({ role }) => {
					if (role === "staff-engineer") throw new Error("staff-engineer setup failed");
					return {
						prompt: async () => "[L1] Scope evidence",
						dispose: () => {
							disposed.push(role);
							throw new Error("tech-lead cleanup failed");
						},
					};
				},
			}),
		).rejects.toThrow("staff-engineer setup failed");

		expect(disposed).toEqual(["tech-lead"]);
	});

	it("loads independent role models while keeping QA read-only", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		const config = loadAnsteelConfig(cwd);

		expect(config.roles["tech-lead"].model).toBe("anthropic/claude-sonnet");
		expect(config.roles["staff-engineer"].model).toBe("openai/gpt-5");
		expect(config.roles["qa-engineer"].model).toBe("deepseek/deepseek-chat");
		expect(config.roles["qa-engineer"].tools).toEqual(["read", "grep", "find", "ls"]);
		expect(config.stageTimeoutMs).toBe(120_000);
		expect(config.maxToolCallsPerStage).toBe(4);
	});

	it("rejects a stage timeout that cannot enforce a bounded review", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				stageTimeoutMs: 0,
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel stageTimeoutMs must be an integer between 1");
	});

	it("rejects an Ansteel tool budget that cannot bound a role stage", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				maxToolCallsPerStage: 0,
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel maxToolCallsPerStage must be an integer between 1");
	});

	it("requires a project-local Ansteel configuration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);

		expect(() => loadAnsteelConfig(cwd)).toThrow(`Ansteel governance requires ${join(cwd, ".pi", "ansteel.json")}`);
	});

	it("rejects a configured report directory outside the reviewed project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				reportDirectory: "../outside-ansteel-reports",
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel reportDirectory must stay inside the reviewed project");
	});

	it("requires an explicit model for every governance role before creating sessions", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		const review = runAnsteelProjectReview<TestModel>({
			topic: "Review mandatory role models",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read"] },
					"staff-engineer": { tools: ["read"] },
					"qa-engineer": { model: "deepseek/chat", tools: ["read"] },
				},
				reportDirectory: "unused",
			} as unknown as AnsteelConfig,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => {
				createdSessionCount++;
				return {
					prompt: async () => "[L2] Unexpected role response",
					dispose: () => {},
				};
			},
		});

		await expect(review).rejects.toMatchObject({
			name: "AnsteelGovernanceSetupError",
			phase: "configuration",
			role: "staff-engineer",
		});
		await expect(review).rejects.toThrow("Ansteel role staff-engineer requires an explicit provider/model");

		expect(createdSessionCount).toBe(0);
	});

	it("rejects duplicate role models before creating governance sessions", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review duplicate role models",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "shared/model", tools: ["read"] },
						"staff-engineer": { model: "shared/model", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read"] },
					},
					reportDirectory: "unused",
				},
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async () => {
					createdSessionCount++;
					return {
						prompt: async () => "[L2] Unexpected role response",
						dispose: () => {},
					};
				},
			}),
		).rejects.toThrow(
			"Ansteel governance requires distinct role models: staff-engineer duplicates tech-lead (shared/model)",
		);

		expect(createdSessionCount).toBe(0);
	});

	it("rejects supplied QA bash configuration before creating any role session", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review supplied configuration validation",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "tech/lead", tools: ["read"] },
						"staff-engineer": { model: "staff/engineer", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read", "bash"] },
					},
					reportDirectory: "unused",
				},
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async () => {
					createdSessionCount++;
					return {
						prompt: async () => "VERDICT: APPROVE",
						dispose: () => {},
					};
				},
			}),
		).rejects.toThrow("Ansteel QA cannot use bash");

		expect(createdSessionCount).toBe(0);
	});

	it("creates isolated role sessions with the configured models", async () => {
		type TestModel = { provider: string; id: string };
		const calls: Array<{ role: AnsteelRole; model: TestModel; tools: readonly string[] }> = [];
		const disposed: AnsteelRole[] = [];
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the parser",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read", "bash"] },
					"staff-engineer": { model: "openai/gpt-5", tools: ["read", "grep"] },
					"qa-engineer": { model: "deepseek/chat", tools: ["read", "grep", "find", "ls"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role, model, tools }) => {
				calls.push({ role, model, tools });
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.roleModels["tech-lead"]).toEqual({ provider: "claude", id: "sonnet" });
		expect(result.roleModels["staff-engineer"]).toEqual({ provider: "openai", id: "gpt-5" });
		expect(calls.map(({ role }) => role)).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("preserves a trailing-space QA verdict from a role session and rejects it", async () => {
		type TestModel = { provider: string; id: string };
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the role-session QA gate",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => {
				return {
					prompt: async (prompt) =>
						responseForMutualReviewStage(getStageFromPrompt(prompt), { "qa-verification": "VERDICT: APPROVE " }),
					dispose: () => {},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe("VERDICT: APPROVE ");
		expect(result.markdown).toContain("VERDICT: APPROVE \n");
	});

	it("preserves a trailing-space rejected QA verdict when session cleanup fails", async () => {
		type TestModel = { provider: string; id: string };
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup report integrity",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async (prompt) =>
					responseForMutualReviewStage(getStageFromPrompt(prompt), { "qa-verification": "VERDICT: APPROVE " }),
				dispose: () => {
					if (role === "qa-engineer") throw new Error("QA cleanup failed");
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe("VERDICT: APPROVE ");
		expect(result.cleanupFailures).toEqual([{ role: "qa-engineer", reason: "QA cleanup failed" }]);
		expect(result.markdown).toContain("VERDICT: APPROVE \n\n## Session Cleanup Failures");
	});

	it("returns an auditable rejection for a whitespace-only QA session response", async () => {
		type TestModel = { provider: string; id: string };
		const calls: Array<{ role: AnsteelRole; prompt: string }> = [];
		const disposed: AnsteelRole[] = [];
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the whitespace-only QA response",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				return {
					prompt: async (prompt) => {
						calls.push({ role, prompt });
						const stage = getStageFromPrompt(prompt);
						return stage === "qa-verification" ? " \t " : responseForMutualReviewStage(stage);
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe(" \t ");
		expect(result.markdown).toContain("qa-engineer / qa-verification returned an empty or whitespace-only response");
		expect(calls).toHaveLength(6);
		expect(calls.some(({ prompt }) => prompt.includes("Current stage: consensus."))).toBe(false);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("allows an exact QA approval marker with a Verdict rationale line", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review the verdict parser",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"qa-verification":
						"VERDICT: APPROVE\nVerdict rationale: [L1] The required test passed\n[L2] Monitor the follow-up",
					consensus: "[L2] Consensus",
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L2] Consensus");
	});

	it("uses a nonzero CLI outcome for a rejected review", () => {
		expect(getAnsteelReviewExitCode("rejected")).toBe(1);
		expect(getAnsteelReviewExitCode("approved")).toBe(0);
	});

	it("writes an auditable Markdown report below the configured report directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		const reportDirectory = join(cwd, ".pi", "ansteel-reports");

		const reportPath = writeAnsteelReport({
			reportDirectory,
			topic: "Review parser safety",
			markdown: "# Review\n\n[L1] Evidence\nRaw transcript trailing space: ",
			now: new Date("2026-07-22T08:15:30.000Z"),
		});

		expect(reportPath.startsWith(reportDirectory)).toBe(true);
		expect(existsSync(reportPath)).toBe(true);
		expect(readFileSync(reportPath, "utf-8")).toBe("# Review\n\n[L1] Evidence\nRaw transcript trailing space: ");
	});

	it("formats a sanitized setup rejection with the configured governance models", () => {
		const markdown = createAnsteelSetupFailureMarkdown({
			topic: "Review setup failure archiving",
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read"] },
					"staff-engineer": { model: "openai/gpt-5", tools: ["read"] },
					"qa-engineer": { model: "deepseek/chat", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			error: new AnsteelGovernanceSetupError(
				"Authorization: Bearer top-secret-token; API key: super-secret-key\nwhile resolving the model",
				"model-resolution",
				"staff-engineer",
			),
		});

		expect(markdown).toContain("- Result: REJECTED");
		expect(markdown).toContain("- Failed role: staff-engineer");
		expect(markdown).toContain("- Failed phase: model-resolution");
		expect(markdown).toContain("- tech-lead: claude/sonnet");
		expect(markdown).toContain("- staff-engineer: openai/gpt-5");
		expect(markdown).toContain("Authorization: Bearer [REDACTED]");
		expect(markdown).toContain("API key: [REDACTED]");
		expect(markdown).not.toContain("top-secret-token");
		expect(markdown).not.toContain("super-secret-key");
	});
});

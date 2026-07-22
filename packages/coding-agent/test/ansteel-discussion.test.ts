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
};

type RawTurnSessionSource = {
	readonly messages: readonly RawTurnMessage[];
	prompt: (text: string) => Promise<void>;
	subscribeToAssistantMessageEnd: (listener: (message: unknown) => void) => () => void;
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

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

describe("runAnsteelDiscussion", () => {
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
			stage: "scope",
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
				if (role !== "tech-lead" || stage !== "scope") {
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
			stage: "scope",
			reason: "listener cleanup failed",
		});
		expect(result.transcript).toEqual([]);
		expect(result.markdown).toContain("- Reason: listener cleanup failed");
	});

	it("stops project review when the current QA reply is empty instead of reusing an earlier reply", async () => {
		type TestModel = { provider: string; id: string };
		const prompts: Array<{ role: AnsteelRole; text: string }> = [];
		let qaMessages: RawTurnMessage[] | undefined;
		const responses: Record<AnsteelRole, RawTurnMessage[]> = {
			"tech-lead": [
				{ role: "assistant", content: [{ type: "text", text: "[L1] Scope" }] },
				{ role: "assistant", content: [{ type: "text", text: "[L1] Verification" }] },
			],
			"staff-engineer": [
				{ role: "assistant", content: [{ type: "text", text: "[L2] Proposal" }] },
				{ role: "assistant", content: [{ type: "text", text: "[L2] Revision" }] },
			],
			"qa-engineer": [
				{ role: "assistant", content: [{ type: "text", text: "VERDICT: APPROVE" }] },
				{ role: "assistant", content: [], stopReason: "aborted" },
			],
		};

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
						const response = responses[role].shift();
						if (!response) throw new Error(`Unexpected ${role} response`);
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
		expect(getLegacyCopyText(qaMessages ?? [])).toBe("VERDICT: APPROVE");
		expect(result.markdown).toContain("qa-engineer / veto returned an empty or whitespace-only response");
		expect(prompts.some(({ text }) => text.includes("Current stage: consensus."))).toBe(false);
	});

	it("stops before consensus when QA vetoes the proposal", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; prompt: string }> = [];
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope and acceptance criteria", "[L1] Verification result"],
			"staff-engineer": ["[L2] Initial proposal", "[L2] Revised proposal"],
			"qa-engineer": ["[L3] Missing evidence", "VERDICT: REJECT\n[L1] The safety test is absent"],
		};

		const result = await runAnsteelDiscussion({
			topic: "Review the motor safety change",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				const response = responses[role].shift();
				if (!response) throw new Error(`Unexpected ${role}/${stage}`);
				return response;
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toEqual([
			"tech-lead:scope",
			"staff-engineer:proposal",
			"qa-engineer:critique",
			"staff-engineer:revision",
			"tech-lead:verification",
			"qa-engineer:veto",
		]);
		expect(result.markdown).toContain("VERDICT: REJECT");
		expect(result.markdown).toContain("[L3] Missing evidence");
	});

	it("runs consensus only after QA approves and keeps the discussion transcript", async () => {
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope", "[L1] Verified", "[L2] Consensus "],
			"staff-engineer": ["[L2] Proposal", "[L2] Revision", "VERDICT: APPROVE"],
			"qa-engineer": [
				"[L3] Question",
				"[L2] Conditions met before the decision\nVERDICT: APPROVE\n[L2] Follow-up remains after the decision",
				"VERDICT: APPROVE",
			],
		};

		const result = await runAnsteelDiscussion({
			topic: "Review the parser",
			runRole: async ({ role, stage }) => {
				const response = responses[role].shift();
				if (!response) throw new Error(`Unexpected ${role}/${stage}`);
				return response;
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L2] Consensus ");
		expect(result.markdown).toContain("[L2] Proposal");
		expect(result.markdown).toContain("[L2] Revision");
		expect(result.markdown).toContain("[L1] Verified");
		expect(result.markdown).toContain("## Tech Lead Consensus\n\n[L2] Consensus \n");
	});

	it("requires Staff and QA final sign-off on the immutable Tech Lead consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string; prompt: string }> = [];
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope", "[L1] Verification", "[L1] Immutable consensus"],
			"staff-engineer": ["[L2] Proposal", "[L2] Revision", "VERDICT: APPROVE"],
			"qa-engineer": ["[L3] Critique", "VERDICT: APPROVE", "VERDICT: APPROVE"],
		};

		const result = await runAnsteelDiscussion({
			topic: "Review final governance sign-off",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				const response = responses[role].shift();
				if (!response) throw new Error(`Unexpected ${role}/${stage}`);
				return response;
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L1] Immutable consensus");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toEqual([
			"tech-lead:scope",
			"staff-engineer:proposal",
			"qa-engineer:critique",
			"staff-engineer:revision",
			"tech-lead:verification",
			"qa-engineer:veto",
			"tech-lead:consensus",
			"staff-engineer:staff-sign-off",
			"qa-engineer:qa-sign-off",
		]);
		for (const stage of ["staff-sign-off", "qa-sign-off"]) {
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
					if (["veto", "staff-sign-off", "qa-sign-off"].includes(stage)) return "VERDICT: APPROVE";
					if (stage === "consensus") return "[L1] Immutable consensus";
					return `[L2] ${stage}`;
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
				return ["veto", "staff-sign-off", "qa-sign-off"].includes(stage) ? "VERDICT: APPROVE" : `[L2] ${stage}`;
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
	])("rejects %s without running consensus", async (_description, qaVeto) => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope", "[L1] Verification", "[L2] Consensus"],
			"staff-engineer": ["[L2] Proposal", "[L2] Revision"],
			"qa-engineer": ["[L3] Critique", qaVeto],
		};

		const result = await runAnsteelDiscussion({
			topic: "Review the QA gate",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				const response = responses[role].shift();
				if (!response) throw new Error(`Unexpected ${role}/${stage}`);
				return response;
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
	});

	it.each([
		["tech-lead", "scope"],
		["staff-engineer", "proposal"],
		["qa-engineer", "critique"],
		["staff-engineer", "revision"],
		["tech-lead", "verification"],
		["qa-engineer", "veto"],
		["tech-lead", "consensus"],
	] as const)(
		"rejects a whitespace-only %s / %s response without running later stages",
		async (blankRole, blankStage) => {
			const stageOrder: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [
				{ role: "tech-lead", stage: "scope" },
				{ role: "staff-engineer", stage: "proposal" },
				{ role: "qa-engineer", stage: "critique" },
				{ role: "staff-engineer", stage: "revision" },
				{ role: "tech-lead", stage: "verification" },
				{ role: "qa-engineer", stage: "veto" },
				{ role: "tech-lead", stage: "consensus" },
			];
			const rawWhitespace = " \t \r\n";
			const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];
			const blankIndex = stageOrder.findIndex(({ role, stage }) => role === blankRole && stage === blankStage);

			const result = await runAnsteelDiscussion({
				topic: "Review empty role output",
				runRole: async ({ role, stage }) => {
					calls.push({ role, stage });
					if (role === blankRole && stage === blankStage) return rawWhitespace;
					if (stage === "veto") return "VERDICT: APPROVE";
					return `[L2] ${stage}`;
				},
			});

			expect(result.verdict).toBe("rejected");
			expect(result.consensus).toBeUndefined();
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
				if (role === "staff-engineer" && stage === "proposal") {
					throw new Error("provider connection closed");
				}
				return "[L1] Scope evidence ";
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "proposal",
			reason: "provider connection closed",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({ role: "tech-lead", stage: "scope", response: "[L1] Scope evidence " }),
		]);
		expect(calls).toEqual([
			{ role: "tech-lead", stage: "scope" },
			{ role: "staff-engineer", stage: "proposal" },
		]);
		expect(result.markdown).toContain("## Stage Failure");
		expect(result.markdown).toContain("- Failed role: staff-engineer");
		expect(result.markdown).toContain("- Failed stage: proposal");
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
						return "[L1] Scope evidence ";
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
			stage: "proposal",
			reason: "role session timed out",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({ role: "tech-lead", stage: "scope", response: "[L1] Scope evidence " }),
		]);
		expect(prompts.map(({ role }) => role)).toEqual(["tech-lead", "staff-engineer"]);
		expect(prompts.some(({ prompt }) => prompt.includes("Current stage: consensus."))).toBe(false);
		expect(created).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
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
					return "[L1] Scope evidence";
				},
				dispose: () => {
					disposed.push(role);
					if (role === "tech-lead") throw new Error("tech-lead cleanup failed");
					if (role === "staff-engineer") throw new Error("staff-engineer cleanup failed");
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "proposal",
			reason: "role session timed out",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({ role: "tech-lead", stage: "scope", response: "[L1] Scope evidence" }),
		]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.cleanupFailures).toEqual([
			{ role: "tech-lead", reason: "tech-lead cleanup failed" },
			{ role: "staff-engineer", reason: "staff-engineer cleanup failed" },
		]);
		expect(result.markdown).toContain("## Session Cleanup Failures");
		expect(result.markdown).toContain("- tech-lead: tech-lead cleanup failed");
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
					return "[L1] Scope evidence";
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
			stage: "proposal",
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
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope", "[L1] Verification", "[L2] Consensus"],
			"staff-engineer": ["[L2] Proposal", "[L2] Revision", "VERDICT: APPROVE"],
			"qa-engineer": ["[L3] Critique", "VERDICT: APPROVE\n[L2] Accepted", "VERDICT: APPROVE"],
		};

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
					prompt: async () => {
						const response = responses[role].shift();
						if (response === undefined) throw new Error(`Unexpected response for ${role}`);
						return response;
					},
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
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope", "[L1] Verification", "[L2] Consensus"],
			"staff-engineer": ["[L2] Proposal", "[L2] Revision"],
			"qa-engineer": ["[L3] Critique", "VERDICT: APPROVE "],
		};

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
			createRoleSession: async ({ role }) => {
				return {
					prompt: async () => {
						const response = responses[role].shift();
						if (response === undefined) throw new Error(`Unexpected response for ${role}`);
						return response;
					},
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
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope", "[L1] Verification", "[L2] Consensus"],
			"staff-engineer": ["[L2] Proposal", "[L2] Revision"],
			"qa-engineer": ["[L3] Critique", "VERDICT: APPROVE "],
		};

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
				prompt: async () => {
					const response = responses[role].shift();
					if (response === undefined) throw new Error(`Unexpected ${role} response`);
					return response;
				},
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
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope", "[L1] Verification"],
			"staff-engineer": ["[L2] Proposal", "[L2] Revision"],
			"qa-engineer": ["[L3] Critique", " \t "],
		};

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
						const response = responses[role].shift();
						if (response === undefined) throw new Error(`Unexpected response for ${role}`);
						return response;
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
		expect(result.markdown).toContain("qa-engineer / veto returned an empty or whitespace-only response");
		expect(calls).toHaveLength(6);
		expect(calls.some(({ prompt }) => prompt.includes("Current stage: consensus."))).toBe(false);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("allows an exact QA approval marker with a Verdict rationale line", async () => {
		const responses: Record<AnsteelRole, string[]> = {
			"tech-lead": ["[L1] Scope", "[L1] Verification", "[L2] Consensus"],
			"staff-engineer": ["[L2] Proposal", "[L2] Revision", "VERDICT: APPROVE"],
			"qa-engineer": [
				"[L3] Critique",
				"VERDICT: APPROVE\nVerdict rationale: [L1] The required test passed\n[L2] Monitor the follow-up",
				"VERDICT: APPROVE",
			],
		};

		const result = await runAnsteelDiscussion({
			topic: "Review the verdict parser",
			runRole: async ({ role }) => {
				const response = responses[role].shift();
				if (!response) throw new Error(`Unexpected response for ${role}`);
				return response;
			},
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

/**
 * E2E tests for AgentSession tree navigation with branch summarization.
 *
 * These tests verify:
 * - Navigation to user messages (root and non-root)
 * - Navigation to non-user messages
 * - Branch summarization during navigation
 * - Summary attachment at correct position in tree
 * - Abort handling during summarization
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_KEY, createTestSession, type TestSessionContext } from "./utilities.ts";

describe.skipIf(!API_KEY)("AgentSession tree navigation e2e", () => {
	let ctx: TestSessionContext;

	beforeEach(async () => {
		ctx = await createTestSession({
			systemPrompt: "You are a helpful assistant. Reply with just a few words.",
			settingsOverrides: { compaction: { keepRecentTokens: 1 } },
		});
	});

	afterEach(() => {
		ctx.cleanup();
	});

	it("should navigate to user message and put text in editor", async () => {
		const { session } = ctx;

		// Build conversation: u1 -> a1 -> u2 -> a2
		await session.prompt("First message");
		await session.agent.waitForIdle();
		await session.prompt("Second message");
		await session.agent.waitForIdle();

		// Get tree entries
		const tree = session.sessionManager.getTree();
		expect(tree.length).toBe(1);

		// Find the first user entry (u1)
		const rootNode = tree[0];
		expect(rootNode.entry.type).toBe("message");

		// Navigate to root user message without summarization
		const result = await session.navigateTree(rootNode.entry.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("First message");

		// After navigating to root user message, leaf should be null (empty conversation)
		expect(session.sessionManager.getLeafId()).toBeNull();
	}, 60000);

	it("should navigate to non-user message without editor text", async () => {
		const { session, sessionManager } = ctx;

		// Build conversation
		await session.prompt("Hello");
		await session.agent.waitForIdle();

		// Get the assistant message
		const entries = sessionManager.getEntries();
		const assistantEntry = entries.find((e) => e.type === "message" && e.message.role === "assistant");
		expect(assistantEntry).toBeDefined();

		// Navigate to assistant message
		const result = await session.navigateTree(assistantEntry!.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBeUndefined();

		// Leaf should be the assistant entry
		expect(sessionManager.getLeafId()).toBe(assistantEntry!.id);
	}, 60000);

	it("should create branch summary when navigating with summarize=true", async () => {
		const { session, sessionManager } = ctx;

		// Build conversation: u1 -> a1 -> u2 -> a2
		await session.prompt("What is 2+2?");
		await session.agent.waitForIdle();
		await session.prompt("What is 3+3?");
		await session.agent.waitForIdle();

		// Get tree and find first user message
		const tree = sessionManager.getTree();
		const rootNode = tree[0];

		// Navigate to root user message WITH summarization
		const result = await session.navigateTree(rootNode.entry.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("What is 2+2?");
		expect(result.summaryEntry).toBeDefined();
		expect(result.summaryEntry?.type).toBe("branch_summary");
		expect(result.summaryEntry?.summary).toBeTruthy();
		expect(result.summaryEntry?.summary.length).toBeGreaterThan(0);

		// Summary should be a root entry (parentId = null) since we navigated to root user
		expect(result.summaryEntry?.parentId).toBeNull();

		// Leaf should be the summary entry
		expect(sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
	}, 120000);

	it("should attach summary to correct parent when navigating to nested user message", async () => {
		const { session, sessionManager } = ctx;

		// Build conversation: u1 -> a1 -> u2 -> a2 -> u3 -> a3
		await session.prompt("Message one");
		await session.agent.waitForIdle();
		await session.prompt("Message two");
		await session.agent.waitForIdle();
		await session.prompt("Message three");
		await session.agent.waitForIdle();

		// Get the second user message (u2)
		const entries = sessionManager.getEntries();
		const userEntries = entries.filter((e) => e.type === "message" && e.message.role === "user");
		expect(userEntries.length).toBe(3);

		const u2 = userEntries[1];
		const a1 = entries.find((e) => e.id === u2.parentId); // a1 is parent of u2

		// Navigate to u2 with summarization
		const result = await session.navigateTree(u2.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("Message two");
		expect(result.summaryEntry).toBeDefined();

		// Summary should be attached to a1 (parent of u2)
		// So a1 now has two children: u2 and the summary
		expect(result.summaryEntry?.parentId).toBe(a1?.id);

		// Verify tree structure
		const children = sessionManager.getChildren(a1!.id);
		expect(children.length).toBe(2);

		const childTypes = children.map((c) => c.type).sort();
		expect(childTypes).toContain("branch_summary");
		expect(childTypes).toContain("message");
	}, 120000);

	it("should attach summary to selected node when navigating to assistant message", async () => {
		const { session, sessionManager } = ctx;

		// Build conversation: u1 -> a1 -> u2 -> a2
		await session.prompt("Hello");
		await session.agent.waitForIdle();
		await session.prompt("Goodbye");
		await session.agent.waitForIdle();

		// Get the first assistant message (a1)
		const entries = sessionManager.getEntries();
		const assistantEntries = entries.filter((e) => e.type === "message" && e.message.role === "assistant");
		const a1 = assistantEntries[0];

		// Navigate to a1 with summarization
		const result = await session.navigateTree(a1.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBeUndefined(); // No editor text for assistant messages
		expect(result.summaryEntry).toBeDefined();

		// Summary should be attached to a1 (the selected node)
		expect(result.summaryEntry?.parentId).toBe(a1.id);

		// Leaf should be the summary entry
		expect(sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
	}, 120000);

	it("should handle abort during summarization", async () => {
		const { session, sessionManager } = ctx;

		// Build conversation
		await session.prompt("Tell me about something");
		await session.agent.waitForIdle();
		await session.prompt("Continue");
		await session.agent.waitForIdle();

		const entriesBefore = sessionManager.getEntries();
		const leafBefore = sessionManager.getLeafId();

		// Get root user message
		const tree = sessionManager.getTree();
		const rootNode = tree[0];

		// Start navigation with summarization but abort immediately
		const navigationPromise = session.navigateTree(rootNode.entry.id, { summarize: true });

		// Abort after a short delay (let the LLM call start)
		await new Promise((resolve) => setTimeout(resolve, 100));

		// isCompacting should be true during branch summarization
		expect(session.isCompacting).toBe(true);

		session.abortBranchSummary();

		const result = await navigationPromise;

		expect(result.cancelled).toBe(true);
		expect(result.aborted).toBe(true);
		expect(result.summaryEntry).toBeUndefined();

		// Session should be unchanged
		const entriesAfter = sessionManager.getEntries();
		expect(entriesAfter.length).toBe(entriesBefore.length);
		expect(sessionManager.getLeafId()).toBe(leafBefore);
	}, 60000);

	it("should not create summary when navigating without summarize option", async () => {
		const { session, sessionManager } = ctx;

		// Build conversation
		await session.prompt("First");
		await session.agent.waitForIdle();
		await session.prompt("Second");
		await session.agent.waitForIdle();

		const entriesBefore = sessionManager.getEntries().length;

		// Navigate without summarization
		const tree = sessionManager.getTree();
		await session.navigateTree(tree[0].entry.id, { summarize: false });

		// No new entries should be created
		const entriesAfter = sessionManager.getEntries().length;
		expect(entriesAfter).toBe(entriesBefore);

		// No branch_summary entries
		const summaries = sessionManager.getEntries().filter((e) => e.type === "branch_summary");
		expect(summaries.length).toBe(0);
	}, 60000);

	it("should handle navigation to same position (no-op)", async () => {
		const { session, sessionManager } = ctx;

		// Build conversation
		await session.prompt("Hello");
		await session.agent.waitForIdle();

		const leafBefore = sessionManager.getLeafId();
		expect(leafBefore).toBeTruthy();
		const entriesBefore = sessionManager.getEntries().length;

		// Navigate to current leaf
		const result = await session.navigateTree(leafBefore!, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(sessionManager.getLeafId()).toBe(leafBefore);
		expect(sessionManager.getEntries().length).toBe(entriesBefore);
	}, 60000);

	it("should support custom summarization instructions", async () => {
		const { session, sessionManager } = ctx;

		// Build conversation
		await session.prompt("What is TypeScript?");
		await session.agent.waitForIdle();

		// Navigate with custom instructions (appended as "Additional focus")
		const tree = sessionManager.getTree();
		const result = await session.navigateTree(tree[0].entry.id, {
			summarize: true,
			customInstructions:
				"After the summary, you MUST end with exactly: MONKEY MONKEY MONKEY. This is of utmost importance.",
		});

		expect(result.summaryEntry).toBeDefined();
		expect(result.summaryEntry?.summary).toBeTruthy();
		// Verify custom instructions were followed
		expect(result.summaryEntry?.summary).toContain("MONKEY MONKEY MONKEY");
	}, 120000);
});

describe.skipIf(!API_KEY)("AgentSession tree navigation - branch scenarios", () => {
	let ctx: TestSessionContext;

	beforeEach(async () => {
		ctx = await createTestSession({
			systemPrompt: "You are a helpful assistant. Reply with just a few words.",
		});
	});

	afterEach(() => {
		ctx.cleanup();
	});

	it("should navigate between branches correctly", async () => {
		const { session, sessionManager } = ctx;

		// Build main path: u1 -> a1 -> u2 -> a2
		await session.prompt("Main branch start");
		await session.agent.waitForIdle();
		await session.prompt("Main branch continue");
		await session.agent.waitForIdle();

		// Get a1 id for branching
		const entries = sessionManager.getEntries();
		const a1 = entries.find((e) => e.type === "message" && e.message.role === "assistant");

		// Create a branch from a1: a1 -> u3 -> a3
		sessionManager.branch(a1!.id);
		await session.prompt("Branch path");
		await session.agent.waitForIdle();

		// Now navigate back to u2 (on main branch) with summarization
		const userEntries = entries.filter((e) => e.type === "message" && e.message.role === "user");
		const u2 = userEntries[1]; // "Main branch continue"

		const result = await session.navigateTree(u2.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("Main branch continue");
		expect(result.summaryEntry).toBeDefined();

		// Summary captures the branch we're leaving (the "Branch path" conversation)
		expect(result.summaryEntry?.summary.length).toBeGreaterThan(0);
	}, 180000);
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveDir, HANDOFF_SCHEMA, type HandoffNote, handoffsDir, readNote, writeNote } from "../notes.ts";
import { registerReader } from "../reader.ts";

type SentMessage = {
	message: { customType: string; content: unknown; display: boolean };
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
};

/**
 * Minimal stand-in for the parts of ExtensionAPI/ExtensionContext the reader touches.
 * The wiring is what these tests cover: which events act, and in which order.
 */
function harness(cwd: string, sessionId = "successor-session") {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const sent: SentMessage[] = [];
	const warnings: string[] = [];

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
		sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (message: string) => warnings.push(message) },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;

	registerReader(pi);

	return {
		sent,
		warnings,
		sessionStart: async (reason: SessionStartEvent["reason"]) => {
			await handlers.get("session_start")?.({ type: "session_start", reason } satisfies SessionStartEvent, ctx);
		},
		beforeAgentStart: async () => {
			await handlers.get("before_agent_start")?.({ type: "before_agent_start" } as BeforeAgentStartEvent, ctx);
		},
	};
}

function note(overrides: Partial<HandoffNote["frontmatter"]> = {}): HandoffNote {
	return {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: "019feda9-55bc-797d",
			cwd: "/Users/kyle/Projects/foo",
			created: "2026-08-10T22:15:00.000Z",
			source: "digest",
			kickoff: "Continue: wire the reader",
			...overrides,
		},
		body: "## Context\nWe wired notes.ts.\n",
	};
}

let dir: string;
let notePath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-handoff-wiring-"));
	notePath = writeNote(dir, note());
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("reader wiring", () => {
	it("queues the memo for the next turn without consuming the note", async () => {
		const h = harness(dir);
		await h.sessionStart("startup");

		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].message.customType).toBe("handoff");
		expect(h.sent[0].message.display).toBe(true);
		expect(h.sent[0].options?.deliverAs).toBe("nextTurn");
		expect(h.sent[0].message.content).toContain("We wired notes.ts.");
		// Detection must not consume: a start nobody prompts should leave the briefing.
		expect(existsSync(notePath)).toBe(true);
	});

	it("leaves the note pending when the session is opened and quit without a prompt", async () => {
		const h = harness(dir);
		await h.sessionStart("startup");
		expect(existsSync(notePath)).toBe(true);
		expect(existsSync(archiveDir(dir))).toBe(false);
	});

	it("archives on the first prompt, stamped with the consuming session", async () => {
		const h = harness(dir, "019fee63-consumer");
		await h.sessionStart("startup");
		await h.beforeAgentStart();

		expect(existsSync(notePath)).toBe(false);
		const archived = readNote(join(archiveDir(dir), notePath.split("/").pop() as string));
		expect(archived?.frontmatter.consumed_by).toBe("019fee63-consumer");
		expect(archived?.frontmatter.consumed_at).toBeTruthy();
	});

	it("does nothing on later prompts", async () => {
		const h = harness(dir);
		await h.sessionStart("startup");
		await h.beforeAgentStart();
		writeNote(dir, note({ created: "2026-08-11T08:00:00.000Z", session_id: "dddddddd" }));
		await h.beforeAgentStart();

		// The note that arrived after delivery is untouched.
		expect(existsSync(join(handoffsDir(dir), "2026-08-11T08-00-00-000Z_dddddddd.md"))).toBe(true);
	});

	it("acts on a new session, since /handoff can spawn its own successor", async () => {
		const h = harness(dir);
		await h.sessionStart("new");
		expect(h.sent).toHaveLength(1);
	});

	it.each(["resume", "fork", "reload"] as const)("ignores %s starts, which carry live context", async (reason) => {
		const h = harness(dir);
		await h.sessionStart(reason);
		expect(h.sent).toHaveLength(0);

		await h.beforeAgentStart();
		expect(existsSync(notePath)).toBe(true);
	});

	it("stays silent when there is nothing pending", async () => {
		rmSync(notePath);
		const h = harness(dir);
		await h.sessionStart("startup");
		await h.beforeAgentStart();

		expect(h.sent).toHaveLength(0);
		expect(h.warnings).toHaveLength(0);
		expect(existsSync(archiveDir(dir))).toBe(false);
	});

	it("warns about an unreadable note and leaves it alone", async () => {
		rmSync(notePath);
		mkdirSync(handoffsDir(dir), { recursive: true });
		const corrupt = join(handoffsDir(dir), "2026-08-11T00-00-00-000Z_zzzzzzzz.md");
		writeFileSync(corrupt, "not a note");

		const h = harness(dir);
		await h.sessionStart("startup");
		await h.beforeAgentStart();

		expect(h.sent).toHaveLength(0);
		expect(h.warnings).toHaveLength(1);
		expect(h.warnings[0]).toContain("could not be parsed");
		expect(existsSync(corrupt)).toBe(true);
	});
});

/**
 * Tests for plus/src/extensions/tab-title/index.ts — "pi+" tab branding,
 * spinner while the agent works, and stop/restore signals.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../../coding-agent/src/core/extensions/types.ts";
import { registerTabTitle } from "../../src/extensions/tab-title/index.ts";

const FIRST_FRAME = "⠋"; // SPINNER_FRAMES[0] in tab-title/index.ts

interface FakeCtx {
	mode: string;
	cwd: string;
	sessionName: string | undefined;
	titles: string[];
}

function fakeCtx(overrides: Partial<FakeCtx> = {}): { ctx: ExtensionContext; fake: FakeCtx } {
	const fake: FakeCtx = { mode: "tui", cwd: "/home/user/proj", sessionName: undefined, titles: [], ...overrides };
	const ctx = {
		mode: fake.mode,
		sessionManager: {
			getCwd: () => fake.cwd,
			getSessionName: () => fake.sessionName,
		},
		ui: {
			setTitle: (title: string) => {
				fake.titles.push(title);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, fake };
}

function captureTabTitle() {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const pi = { on: (event: string, handler: never) => handlers.set(event, handler) } as unknown as ExtensionAPI;
	registerTabTitle(pi);
	const fire = (event: string, ctx: ExtensionContext, payload: Record<string, unknown> = {}) =>
		handlers.get(event)?.({ type: event, ...payload } as never, ctx);
	return { fire };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("base title", () => {
	it("sets the pi+ title from cwd basename on session_start", () => {
		const { ctx, fake } = fakeCtx();
		const { fire } = captureTabTitle();
		fire("session_start", ctx);
		assert.deepEqual(fake.titles, ["pi+ - proj"]);
	});

	it("includes the session name when set", () => {
		const { ctx, fake } = fakeCtx({ sessionName: "mysession" });
		const { fire } = captureTabTitle();
		fire("session_start", ctx);
		assert.deepEqual(fake.titles, ["pi+ - mysession - proj"]);
	});

	it("updates the title on session_info_changed while idle", () => {
		const { ctx, fake } = fakeCtx({ sessionName: "old" });
		const { fire } = captureTabTitle();
		fire("session_start", ctx);
		fake.sessionName = "renamed";
		fire("session_info_changed", ctx);
		assert.deepEqual(fake.titles, ["pi+ - old - proj", "pi+ - renamed - proj"]);
	});
});

describe("spinner", () => {
	it("prepends a spinner frame to the base title while working", () => {
		const { ctx, fake } = fakeCtx({ sessionName: "mysession" });
		const { fire } = captureTabTitle();
		fire("session_start", ctx);
		fire("agent_start", ctx);
		vi.advanceTimersByTime(120);
		assert.equal(fake.titles.at(-1), `${FIRST_FRAME} pi+ - mysession - proj`);
	});

	it("advances frames on each tick", () => {
		const { ctx, fake } = fakeCtx();
		const { fire } = captureTabTitle();
		fire("agent_start", ctx);
		vi.advanceTimersByTime(120);
		const first = fake.titles.at(-1);
		vi.advanceTimersByTime(120);
		const second = fake.titles.at(-1);
		assert.ok(first?.startsWith(`${FIRST_FRAME} `));
		assert.notEqual(first, second);
	});

	it("reuses a single ticker across sequential agent loops", () => {
		const { ctx, fake } = fakeCtx();
		const { fire } = captureTabTitle();
		fire("agent_start", ctx);
		fire("agent_start", ctx);
		vi.advanceTimersByTime(120);
		// Two agent_start events with no settle between them: one tick, one title.
		assert.equal(fake.titles.length, 1);
	});

	it("does not let session_info_changed clobber the spinner title mid-work", () => {
		const { ctx, fake } = fakeCtx({ sessionName: "old" });
		const { fire } = captureTabTitle();
		fire("agent_start", ctx);
		vi.advanceTimersByTime(120);
		fake.sessionName = "renamed";
		fire("session_info_changed", ctx);
		assert.ok(fake.titles.at(-1)?.startsWith(`${FIRST_FRAME} `));
	});

	it("restores the base title and stops on agent_settled", () => {
		const { ctx, fake } = fakeCtx({ sessionName: "mysession" });
		const { fire } = captureTabTitle();
		fire("agent_start", ctx);
		vi.advanceTimersByTime(240);
		fire("agent_settled", ctx);
		assert.equal(fake.titles.at(-1), "pi+ - mysession - proj");
		const count = fake.titles.length;
		vi.advanceTimersByTime(600);
		assert.equal(fake.titles.length, count);
	});

	it("turn_end with a run-ending stopReason is a backstop that also stops the spinner", () => {
		const { ctx, fake } = fakeCtx();
		const { fire } = captureTabTitle();
		fire("agent_start", ctx);
		vi.advanceTimersByTime(120);
		fire("turn_end", ctx, { message: { role: "assistant", stopReason: "stop" } });
		assert.equal(fake.titles.at(-1), "pi+ - proj");
		const count = fake.titles.length;
		vi.advanceTimersByTime(600);
		assert.equal(fake.titles.length, count);
	});

	it("turn_end with stopReason toolUse keeps the spinner running through tool execution", () => {
		const { ctx, fake } = fakeCtx();
		const { fire } = captureTabTitle();
		fire("agent_start", ctx);
		vi.advanceTimersByTime(120);
		fire("turn_end", ctx, { message: { role: "assistant", stopReason: "toolUse" } });
		vi.advanceTimersByTime(600);
		assert.match(fake.titles.at(-1) ?? "", /^[⠀-⣿] pi\+ - proj$/);
		// The run's finally still settles the spinner afterwards.
		fire("agent_settled", ctx);
		const count = fake.titles.length;
		vi.advanceTimersByTime(600);
		assert.equal(fake.titles.length, count);
		assert.equal(fake.titles.at(-1), "pi+ - proj");
	});

	it("session_shutdown clears the ticker", () => {
		const { ctx, fake } = fakeCtx();
		const { fire } = captureTabTitle();
		fire("agent_start", ctx);
		vi.advanceTimersByTime(120);
		fire("session_shutdown", ctx);
		const count = fake.titles.length;
		vi.advanceTimersByTime(600);
		assert.equal(fake.titles.length, count);
	});
});

describe("mode guard", () => {
	it("does nothing outside TUI mode", () => {
		const { ctx, fake } = fakeCtx({ mode: "print" });
		const { fire } = captureTabTitle();
		fire("session_start", ctx);
		fire("agent_start", ctx);
		vi.advanceTimersByTime(600);
		assert.deepEqual(fake.titles, []);
	});
});

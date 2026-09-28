/**
 * Tests for plus/src/extensions/hooks/index.ts — the registerUserHooks
 * wiring: the three CC-analogue events must invoke fireUserHooks with the
 * right event names and payload fields. fireUserHooks is mocked so no real
 * processes spawn.
 */

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../../coding-agent/src/core/extensions/types.ts";

const fireCalls: { event: string; fields: Record<string, string | undefined> }[] = [];
vi.mock("../../src/extensions/hooks/fire.ts", () => ({
	fireUserHooks: (event: string, fields: Record<string, string | undefined>) => {
		fireCalls.push({ event, fields });
	},
}));

import { registerUserHooks } from "../../src/extensions/hooks/index.ts";

function harness(): {
	handlers: Map<string, (event: never, ctx: ExtensionContext) => unknown>;
	fire: (event: Record<string, unknown>, ctx?: ExtensionContext) => unknown;
} {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	registerUserHooks({
		on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);
	return {
		handlers,
		fire: (event: Record<string, unknown>, ctx?: ExtensionContext) => {
			const handler = handlers.get(event.type as string);
			assert.ok(handler, `no handler registered for ${event.type}`);
			return handler(event as never, (ctx ?? {}) as ExtensionContext);
		},
	};
}

describe("registerUserHooks wiring", () => {
	it("registers handlers for ui_prompt_start, tool_execution_start, and agent_settled", () => {
		const { handlers } = harness();
		for (const event of ["ui_prompt_start", "tool_execution_start", "agent_settled"]) {
			assert.ok(handlers.has(event), `handler for ${event} must be registered`);
		}
	});

	it("ui_prompt_start fires PermissionRequest with the prompt kind", () => {
		fireCalls.length = 0;
		const { fire } = harness();
		fire({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
		assert.deepEqual(fireCalls, [{ event: "PermissionRequest", fields: { permission: "custom", mode: undefined } }]);
	});

	it("passes the session mode so hook scripts can ignore headless sessions", () => {
		fireCalls.length = 0;
		const { fire } = harness();
		fire({ type: "agent_settled" }, { mode: "rpc" } as ExtensionContext);
		assert.deepEqual(fireCalls, [{ event: "Stop", fields: { mode: "rpc" } }]);
		fire({ type: "tool_execution_start", toolCallId: "c1", toolName: "ask_user", args: {} }, {
			mode: "tui",
		} as ExtensionContext);
		assert.deepEqual(fireCalls[1], {
			event: "PreToolUse",
			fields: { tool_name: "ask_user", toolName: "ask_user", mode: "tui" },
		});
	});

	it("tool_execution_start fires PreToolUse with tool_name and toolName", () => {
		fireCalls.length = 0;
		const { fire } = harness();
		fire({ type: "tool_execution_start", toolCallId: "c1", toolName: "ask_user", args: {} });
		assert.deepEqual(fireCalls, [
			{ event: "PreToolUse", fields: { tool_name: "ask_user", toolName: "ask_user", mode: undefined } },
		]);
	});

	it("agent_settled fires Stop", () => {
		fireCalls.length = 0;
		const { fire } = harness();
		fire({ type: "agent_settled" });
		assert.deepEqual(fireCalls, [{ event: "Stop", fields: { mode: undefined } }]);
	});
});

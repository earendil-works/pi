import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";

type PermissionContext = {
	_yoloMode: boolean;
	_sessionAllowedToolNames: Set<string>;
	_toolPermissionHandler?: (...args: any[]) => Promise<any>;
	_toolPermissionQueue: Promise<void>;
	_requiresToolPermission(toolName: string): boolean;
};

const proto = AgentSession.prototype as any;

function makeContext(handler?: PermissionContext["_toolPermissionHandler"]): PermissionContext {
	return {
		_yoloMode: false,
		_sessionAllowedToolNames: new Set(),
		_toolPermissionHandler: handler,
		_toolPermissionQueue: Promise.resolve(),
		_requiresToolPermission: proto._requiresToolPermission,
	};
}

describe("AgentSession tool permissions", () => {
	it("allows read-only tools without prompting", async () => {
		const handler = vi.fn(async () => "deny");
		const ctx = makeContext(handler);

		const decision = await proto._requestToolPermission.call(ctx, {
			toolName: "read",
			toolCallId: "tool-1",
			args: { path: "README.md" },
		});

		expect(decision).toBe("allow");
		expect(handler).not.toHaveBeenCalled();
	});

	it("uses the permission handler for side-effect tools", async () => {
		const handler = vi.fn(async () => "deny");
		const ctx = makeContext(handler);

		const decision = await proto._requestToolPermission.call(ctx, {
			toolName: "bash",
			toolCallId: "tool-1",
			args: { command: "npm test" },
		});

		expect(decision).toBe("deny");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("remembers allow_always decisions by tool name", async () => {
		const handler = vi.fn(async () => "allow_always");
		const ctx = makeContext(handler);

		await proto._requestToolPermission.call(ctx, {
			toolName: "edit",
			toolCallId: "tool-1",
			args: {},
		});
		const secondDecision = await proto._requestToolPermission.call(ctx, {
			toolName: "edit",
			toolCallId: "tool-2",
			args: {},
		});

		expect(secondDecision).toBe("allow");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("bypasses prompts in yolo mode", async () => {
		const handler = vi.fn(async () => "deny");
		const ctx = makeContext(handler);
		ctx._yoloMode = true;

		const decision = await proto._requestToolPermission.call(ctx, {
			toolName: "write",
			toolCallId: "tool-1",
			args: { path: "out.txt" },
		});

		expect(decision).toBe("allow");
		expect(handler).not.toHaveBeenCalled();
	});
});

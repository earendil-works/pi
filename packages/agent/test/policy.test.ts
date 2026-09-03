import { describe, expect, it } from "vitest";
import { createCapabilityPolicy, type ToolPolicyContext } from "../src/policy.ts";

function context(toolName: string, args: unknown): ToolPolicyContext {
	return {
		toolCallId: "call-1",
		toolName,
		args,
		toolCall: { type: "toolCall", id: "call-1", name: toolName, arguments: args as Record<string, unknown> },
	};
}

describe("capability tool policy", () => {
	it("allows configured tools and emits an audit event without raw arguments", async () => {
		const audit: string[] = [];
		const policy = createCapabilityPolicy({
			allowTools: ["read"],
			onAudit: (event) => {
				audit.push(`${event.action}:${event.summary}`);
			},
		});

		expect(await policy.authorize(context("read", { path: "src/index.ts" }))).toMatchObject({ action: "allow" });
		expect(audit).toEqual(["allow:read src/index.ts"]);
	});

	it("denies tools and paths outside the configured capabilities", async () => {
		const policy = createCapabilityPolicy({ allowTools: ["read"], allowReadPaths: ["/workspace/src"] });

		expect(await policy.authorize(context("bash", { command: "rm -rf /" }))).toMatchObject({ action: "deny" });
		expect(await policy.authorize(context("read", { path: "/workspace/secrets.txt" }))).toMatchObject({
			action: "deny",
		});
		expect(await policy.authorize(context("read", { path: "/workspace/src/index.ts" }))).toMatchObject({
			action: "allow",
		});
	});
});

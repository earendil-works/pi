import { describe, expect, it } from "vitest";
// Extension factory loads without throwing when env is unset (fail-open guard).
import ext from "../src/index.ts";

describe("agent-ext loads", () => {
	it("registers tools on a fake pi object", () => {
		const tools: string[] = [];
		const handlers = new Map<string, unknown>();
		const fakePi = {
			on: (event: string, fn: unknown) => handlers.set(event, fn),
			registerTool: (t: { name: string }) => tools.push(t.name),
		} as unknown as Parameters<typeof ext>[0];
		ext(fakePi);
		expect(tools).toContain("send_message");
		expect(tools).toContain("read_inbox");
		expect(tools).toContain("reply");
		expect(tools).toContain("spawn");
	});
});

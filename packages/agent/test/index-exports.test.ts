import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../src/index.ts";

describe("pi-agent-core exports", () => {
	it("exposes the generic assistant message event-stream factory", () => {
		const stream = createAssistantMessageEventStream();

		expect(stream).toBeDefined();
		expect(stream.result).toBeTypeOf("function");
	});
});

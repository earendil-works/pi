import { describe, expect, expectTypeOf, it } from "vitest";
import type { Context, JsonValue, Message, ToolResultMessage } from "../src/types.ts";

const base = {
	role: "toolResult" as const,
	toolCallId: "call-1",
	toolName: "read",
	content: [],
	isError: false,
	timestamp: 1,
};

describe("message JSON types", () => {
	it("preserves JSON-compatible detail types without requiring index signatures", () => {
		interface Details {
			path: string;
			items: readonly string[];
			summary?: {
				lines?: number;
			};
		}

		const objectMessage: ToolResultMessage<Details> = {
			...base,
			details: { path: "a.ts", items: ["first"], summary: { lines: 3 } },
		};
		const arrayMessage: ToolResultMessage<string[]> = { ...base, details: ["a", "b"] };
		const readonlyArrayMessage: ToolResultMessage<readonly [string, { readonly count?: number }]> = {
			...base,
			details: ["a", { count: 1 }],
		};
		const primitiveMessage: ToolResultMessage<string> = { ...base, details: "diagnostic" };
		const nullMessage: ToolResultMessage<null> = { ...base, details: null };
		const transcriptMessage: Message = objectMessage;
		const readonlyTranscriptMessage: Message = readonlyArrayMessage;
		const context: Context = { messages: [objectMessage, readonlyArrayMessage] };

		expect(objectMessage.details?.summary?.lines).toBe(3);
		expect(arrayMessage.details).toEqual(["a", "b"]);
		expect(readonlyArrayMessage.details).toEqual(["a", { count: 1 }]);
		expect(primitiveMessage.details).toBe("diagnostic");
		expect(nullMessage.details).toBeNull();
		expect(transcriptMessage).toBe(objectMessage);
		expect(readonlyTranscriptMessage).toBe(readonlyArrayMessage);
		expect(context.messages).toEqual([objectMessage, readonlyArrayMessage]);
		expectTypeOf<ToolResultMessage["details"]>().toEqualTypeOf<JsonValue | undefined>();
	});

	it("rejects non-JSON detail types", () => {
		type OptionalAny = { value?: any };
		expectTypeOf<ToolResultMessage<OptionalAny>>().toEqualTypeOf<never>();
		expectTypeOf<ToolResultMessage<undefined[]>>().toEqualTypeOf<never>();
		expectTypeOf<ToolResultMessage<{ callback: () => void }>>().toEqualTypeOf<never>();
		expectTypeOf<ToolResultMessage<{ value: unknown }>>().toEqualTypeOf<never>();
		expectTypeOf<ToolResultMessage<{ value: Date }>>().toEqualTypeOf<never>();
	});
});

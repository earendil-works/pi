import { type JsonValue, track } from "@earendil-works/chord/delta";
import { describe, expect, it } from "vitest";
import { assignJson } from "../src/harness/json.ts";

type Doc = { message?: JsonValue };

function assign(tracker: ReturnType<typeof track<Doc>>, value: JsonValue): void {
	const change = tracker.beginChange();
	assignJson(change.state as Doc, "message", value);
	tracker.adopt(change.prepare());
}

describe("assignJson", () => {
	it("does not merge a new __proto__ member into Object.prototype", () => {
		const tracker = track<Doc>({});
		assign(tracker, { args: JSON.parse('{"path":"x"}') });
		assign(tracker, { args: JSON.parse('{"path":"xy","__proto__":{"polluted":true}}') });

		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		const args = (tracker.value.message as { args: object }).args;
		expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toEqual({ polluted: true });
	});
});

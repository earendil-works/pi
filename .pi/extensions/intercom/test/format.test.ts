import { describe, expect, it } from "vitest";
import { formatIncoming, senderLabel } from "../format.ts";
import { INTERCOM_SCHEMA, type IntercomMessage } from "../store.ts";

function message(overrides: Partial<IntercomMessage> = {}): IntercomMessage {
	return {
		schema: INTERCOM_SCHEMA,
		channel: "dev",
		sender: "019feda9-55bc-797d-8b97-4fe03f430270",
		created: "2026-08-11T10:00:00.000Z",
		text: "hello",
		...overrides,
	};
}

describe("senderLabel", () => {
	it("prefers the alias with the short id in parentheses", () => {
		expect(senderLabel(message({ alias: "laptop-player" }))).toBe("laptop-player (019feda9)");
	});

	it("falls back to the short session id", () => {
		expect(senderLabel(message())).toBe("019feda9");
	});
});

describe("formatIncoming", () => {
	it("puts a standalone banner first and one block per message", () => {
		const text = formatIncoming("dev", [
			message({ text: "first" }),
			message({ alias: "phone-player", created: "2026-08-11T10:00:05.000Z", text: "second\n" }),
		]);
		expect(text).toBe(
			[
				"Intercom #dev — 2 new messages",
				"",
				"From 019feda9 at 2026-08-11T10:00:00.000Z:",
				"first",
				"",
				"From phone-player (019feda9) at 2026-08-11T10:00:05.000Z:",
				"second",
			].join("\n"),
		);
	});

	it("uses the singular for one message", () => {
		expect(formatIncoming("dev", [message()])).toContain("1 new message\n");
	});
});

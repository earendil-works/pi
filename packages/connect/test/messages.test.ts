import { describe, expect, it } from "vitest";
import { CONNECT_PROTOCOL, parseHelloMessage, parsePopupMessage } from "../src/messages.ts";

describe("parseHelloMessage", () => {
	it("accepts a complete hello and nothing else", () => {
		const hello = {
			protocol: CONNECT_PROTOCOL,
			type: "hello",
			nonce: "n",
			provider: "xai",
			method: "device_code",
			manual: false,
		};
		expect(parseHelloMessage(hello)).toEqual(hello);
		expect(parseHelloMessage({ ...hello, manual: "yes" })).toBeUndefined();
		expect(parseHelloMessage({ ...hello, protocol: "other" })).toBeUndefined();
	});
});

describe("parsePopupMessage", () => {
	it("accepts credentials with the fields pi-ai needs and keeps the provider's extra fields", () => {
		const credential = { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acct" };
		expect(parsePopupMessage({ protocol: CONNECT_PROTOCOL, type: "credential", nonce: "n", credential })).toEqual({
			protocol: CONNECT_PROTOCOL,
			type: "credential",
			nonce: "n",
			credential,
		});
		expect(
			parsePopupMessage({
				protocol: CONNECT_PROTOCOL,
				type: "credential",
				nonce: "n",
				credential: { type: "oauth" },
			}),
		).toBeUndefined();
	});

	it("requires a nonce on everything but ready", () => {
		expect(parsePopupMessage({ protocol: CONNECT_PROTOCOL, type: "ready" })?.type).toBe("ready");
		expect(parsePopupMessage({ protocol: CONNECT_PROTOCOL, type: "cancelled" })).toBeUndefined();
		expect(parsePopupMessage({ protocol: CONNECT_PROTOCOL, type: "error", nonce: "n", message: "m" })).toMatchObject({
			type: "error",
			message: "m",
		});
	});
});

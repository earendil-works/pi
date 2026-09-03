import { describe, expect, test } from "vitest";
import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	decodeCbor,
	encodeCbor,
	encodeClientMessage,
	encodeFrame,
	encodeServerMessage,
	FrameDecoder,
	isSupportedProtocolVersion,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	parseClientMessage,
	parseServerMessage,
	type ServerHello,
	type ServerMessage,
	ServerMessageDecoder,
} from "../src/index.ts";

const clientHello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
const serverHello: ServerHello = {
	type: "hello",
	version: PROTOCOL_VERSION,
	serverId: "00000000-0000-4000-8000-000000000001",
};

describe("protocol validation", () => {
	test("negotiates protocol version 8", () => {
		expect(PROTOCOL_VERSION).toBe(8);
		expect(isSupportedProtocolVersion(8)).toBe(true);
		expect(isSupportedProtocolVersion(7)).toBe(false);
		expect(isSupportedProtocolVersion(8.5)).toBe(false);
	});

	test.each([0, PROTOCOL_VERSION, PROTOCOL_VERSION + 1])(
		"accepts integer client hello version %s for negotiation",
		(version) => expect(parseClientMessage({ ...clientHello, version })).toEqual({ ...clientHello, version }),
	);

	test.each([
		{ type: "hello", version: String(PROTOCOL_VERSION) },
		{ type: "hello", version: PROTOCOL_VERSION + 0.5 },
		{ type: "hello", version: PROTOCOL_VERSION, extra: true },
	])("rejects an invalid client hello", (message) => {
		expect(() => parseClientMessage(message)).toThrow(ProtocolValidationError);
	});

	test.each([
		"",
		"server-1",
		"00000000-0000-7000-8000-000000000001",
		"00000000-0000-4000-7000-000000000001",
		"00000000-0000-4000-8000-00000000000A",
	])("rejects non-canonical UUIDv4 server ID %j", (serverId) => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				target: { serverId },
				call: { serviceId: "pi.models", member: "list", args: [] },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("keeps routed request and event payloads opaque", () => {
		const request: ClientMessage = {
			type: "request",
			id: "request-1",
			target: {
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-1",
				attachmentId: "attachment-1",
			},
			call: {
				serviceId: "application.custom",
				instance: { key: "instance-1", generation: 2 },
				member: "invoke",
				args: [{ arbitrary: true }, ["opaque"]],
			},
		};
		expect(parseClientMessage(request)).toEqual(request);
		expect(
			parseClientMessage({
				...request,
				call: { arbitrary: "strict JSON whose service meaning belongs to Chord" },
			}),
		).toMatchObject({ call: { arbitrary: expect.any(String) } });
		expect(
			parseServerMessage({
				type: "service_update",
				subscriptionId: "subscription-1",
				update: { applicationDefined: true },
			}),
		).toMatchObject({ update: { applicationDefined: true } });
	});

	test("rejects non-JSON opaque payloads", () => {
		const request = {
			type: "request",
			id: "request-1",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "application.custom", member: "invoke", args: [] },
		};
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		for (const [label, value] of [
			["byte array", new Uint8Array([1])],
			["non-finite number", Number.NaN],
			["undefined property", { value: undefined }],
			["cycle", cyclic],
		] as const) {
			expect(() => parseClientMessage({ ...request, call: { ...request.call, args: [value] } }), label).toThrow(
				ProtocolValidationError,
			);
			expect(
				() => parseServerMessage({ type: "response", id: "request-1", ok: true, result: value }),
				label,
			).toThrow(ProtocolValidationError);
		}
	});

	test("validates request cancellation envelopes", () => {
		const cancel: ClientMessage = {
			type: "cancel",
			id: "request-1",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
		};
		expect(parseClientMessage(cancel)).toEqual(cancel);
		expect(() => parseClientMessage({ ...cancel, id: "" })).toThrow(ProtocolValidationError);
		expect(() => parseClientMessage({ ...cancel, extra: true })).toThrow(ProtocolValidationError);
	});

	test("validates attachment route updates", () => {
		const attached: ServerMessage = {
			type: "attachment",
			attachment: {
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-1",
				attachmentId: "attachment-1",
			},
		};
		const detached: ServerMessage = { type: "attachment", attachment: null };
		expect(parseServerMessage(attached)).toEqual(attached);
		expect(parseServerMessage(detached)).toEqual(detached);
		expect(() => parseServerMessage({ ...attached, attachment: { sessionId: "session-1" } })).toThrow(
			ProtocolValidationError,
		);
	});

	test.each([
		[
			"empty request id",
			{
				type: "request",
				id: "",
				target: { serverId: "00000000-0000-4000-8000-000000000001" },
				call: { serviceId: "pi.models", member: "list", args: [] },
			},
		],
		[
			"extra envelope field",
			{
				type: "request",
				id: "request-1",
				target: { serverId: "00000000-0000-4000-8000-000000000001" },
				call: { serviceId: "pi.models", member: "list", args: [] },
				extra: true,
			},
		],
	] as const)("rejects malformed request boundaries: %s", (_label, message) => {
		expect(() => parseClientMessage(message)).toThrow(ProtocolValidationError);
	});

	test("accepts a successful void response without a result field", () => {
		expect(parseServerMessage({ type: "response", id: "request-1", ok: true })).toEqual({
			type: "response",
			id: "request-1",
			ok: true,
		});
	});

	test.each([
		["invalid server id", { ...serverHello, serverId: "server-1" }],
		["extra response field", { type: "response", id: "request-1", ok: true, result: [], extra: true }],
		["empty error code", { type: "response", id: "request-1", ok: false, error: { code: "", message: "bad" } }],
	] as const)("rejects malformed server boundaries: %s", (_label, message) => {
		expect(() => parseServerMessage(message)).toThrow(ProtocolValidationError);
	});

	test.each(["wrong_server", "cancelled", "service_not_found", "application_error"] as const)(
		"accepts the opaque %s error code",
		(code) => {
			const message: ServerMessage = {
				type: "response",
				id: "request-1",
				ok: false,
				error: { code, message: "safe" },
			};
			expect(parseServerMessage(message)).toEqual(message);
		},
	);

	test("rejects unknown messages and fields", () => {
		expect(() => parseServerMessage({ ...serverHello, snapshot: {} })).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage({ type: "unknown", event: {} })).toThrow(ProtocolValidationError);
	});

	test("does not parse JSON strings as messages", () => {
		expect(() => parseClientMessage(JSON.stringify(clientHello))).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage(JSON.stringify(serverHello))).toThrow(ProtocolValidationError);
	});
});

describe("validated framed protocol APIs", () => {
	test("encodes complete client and server frames", () => {
		const clientFrames = new FrameDecoder().push(encodeClientMessage(clientHello));
		expect(parseClientMessage(decodeCbor(clientFrames[0]!))).toEqual(clientHello);
		const serverFrames = new FrameDecoder().push(encodeServerMessage(serverHello));
		expect(parseServerMessage(decodeCbor(serverFrames[0]!))).toEqual(serverHello);
	});

	test("enforces outbound frame limits", () => {
		expect(() => encodeClientMessage(clientHello, { maxFrameLength: 8 })).toThrow(ProtocolValidationError);
		expect(() => encodeServerMessage(serverHello, { maxFrameLength: 8 })).toThrow(ProtocolValidationError);
	});

	test("incrementally decodes fragmented and coalesced client messages", () => {
		const request: ClientMessage = {
			type: "request",
			id: "request-1",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "pi.session-directory", member: "list", args: [] },
		};
		const first = encodeClientMessage(clientHello);
		const second = encodeClientMessage(request);
		const wire = new Uint8Array(first.byteLength + second.byteLength);
		wire.set(first);
		wire.set(second, first.byteLength);

		for (let split = 0; split <= wire.byteLength; split++) {
			const decoder = new ClientMessageDecoder();
			const messages = [...decoder.push(wire.subarray(0, split)), ...decoder.push(wire.subarray(split))];
			decoder.end();
			expect(messages).toEqual([clientHello, request]);
		}
	});

	test("incrementally decodes fragmented and coalesced server messages", () => {
		const response: ServerMessage = { type: "response", id: "request-1", ok: true, result: [] };
		const first = encodeServerMessage(serverHello);
		const second = encodeServerMessage(response);
		const wire = new Uint8Array(first.byteLength + second.byteLength);
		wire.set(first);
		wire.set(second, first.byteLength);

		const split = first.byteLength + Math.floor(second.byteLength / 2);
		const decoder = new ServerMessageDecoder();
		expect(decoder.push(wire.subarray(0, split))).toEqual([serverHello]);
		expect(decoder.push(wire.subarray(split))).toEqual([response]);
		decoder.end();
	});

	test.each([
		["empty CBOR payload", encodeFrame(new Uint8Array())],
		["malformed CBOR", encodeFrame(new Uint8Array([0xff]))],
		["schema-invalid CBOR", encodeFrame(encodeCbor({ type: "hello", version: 1, extra: true }))],
	] as const)("rejects invalid framed input: %s", (_label, wire) => {
		const decoder = new ClientMessageDecoder();
		expect(() => decoder.push(wire)).toThrow(ProtocolValidationError);
		expect(() => decoder.push(encodeClientMessage(clientHello))).toThrow(/failed/i);
	});

	test("rejects truncated and oversized framing", () => {
		const truncated = new ServerMessageDecoder();
		expect(truncated.push(new Uint8Array([0, 0, 0, 2, 1]))).toEqual([]);
		expect(() => truncated.end()).toThrow(ProtocolValidationError);
		const oversized = new ClientMessageDecoder({ maxFrameLength: 3 });
		expect(() => oversized.push(new Uint8Array([0, 0, 0, 4]))).toThrow(ProtocolValidationError);
	});
});

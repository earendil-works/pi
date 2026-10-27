import assert from "node:assert";
import { describe, it } from "node:test";
import { formatProgramStatus, isProgramStatusReply } from "../src/program-status.ts";

function decodeMessage(sequence: string): string | undefined {
	const message = /:msg=([A-Za-z0-9+/=]*)/.exec(sequence)?.[1];
	return message === undefined ? undefined : Buffer.from(message, "base64").toString("utf8");
}

// #10607
describe("formatProgramStatus", () => {
	it("encodes state, app, kind, and a base64 message", () => {
		assert.equal(
			formatProgramStatus({ state: "blocked", app: "pi", kind: "permission", message: "Allow bash?" }),
			`\x1b]7501;state=blocked:app=pi:kind=permission:msg=${Buffer.from("Allow bash?").toString("base64")}\x1b\\`,
		);
		assert.equal(formatProgramStatus({ state: "clear" }), "\x1b]7501;state=clear\x1b\\");
	});

	it("omits kind outside blocked, invalid app names, and empty messages", () => {
		assert.equal(
			formatProgramStatus({ state: "working", app: "my app", kind: "auth", message: " \n " }),
			"\x1b]7501;state=working\x1b\\",
		);
		assert.match(formatProgramStatus({ state: "idle", app: "a".repeat(32) }), /:app=a{32}\x1b/);
		assert.doesNotMatch(formatProgramStatus({ state: "idle", app: "a".repeat(33) }), /app=/);
	});

	it("replaces control characters, which make terminals discard the report", () => {
		const sequence = formatProgramStatus({ state: "error", message: "first\nsecond\x1b[31m\u009bthird\t" });
		assert.equal(decodeMessage(sequence), "first second [31m third");
	});

	it("cuts long messages at a UTF-8 boundary within the spec limits", () => {
		const sequence = formatProgramStatus({ state: "working", app: "pi", message: "é".repeat(2000) });
		const message = decodeMessage(sequence)!;
		assert.equal(message, "é".repeat(1024));
		assert.ok(Buffer.byteLength(message) <= 2048);
		assert.ok(sequence.length <= 4096);
	});
});

describe("isProgramStatusReply", () => {
	it("accepts the query echo with either terminator and future pairs", () => {
		assert.equal(isProgramStatusReply("\x1b]7501;?\x1b\\"), true);
		assert.equal(isProgramStatusReply("\x1b]7501;?\x07"), true);
		assert.equal(isProgramStatusReply("\x1b]7501;?version=2\x1b\\"), true);
		assert.equal(isProgramStatusReply("\x1b]7501;state=idle\x1b\\"), false);
		assert.equal(isProgramStatusReply("\x1b]11;rgb:0000/0000/0000\x07"), false);
	});
});

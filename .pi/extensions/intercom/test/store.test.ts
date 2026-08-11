import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	channelDir,
	clearChannel,
	collectNew,
	ensureGitExclude,
	INTERCOM_SCHEMA,
	type IntercomMessage,
	isValidChannel,
	listChannels,
	listMessageFiles,
	messageFilename,
	parseMessage,
	writeMessage,
} from "../store.ts";

const SENDER_A = "019feda9-55bc-797d-8b97-4fe03f430270";
const SENDER_B = "01a00000-1111-7222-8333-444455556666";

function sampleMessage(overrides: Partial<IntercomMessage> = {}): IntercomMessage {
	return {
		schema: INTERCOM_SCHEMA,
		channel: "dev",
		sender: SENDER_A,
		alias: "laptop-player",
		created: "2026-08-11T10:00:00.000Z",
		text: "Ready when you are.",
		...overrides,
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-intercom-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("isValidChannel", () => {
	it("accepts plain names and rejects separators and dots", () => {
		expect(isValidChannel("dev")).toBe(true);
		expect(isValidChannel("constellation-test_2")).toBe(true);
		expect(isValidChannel("A1")).toBe(true);
		expect(isValidChannel("")).toBe(false);
		expect(isValidChannel("../escape")).toBe(false);
		expect(isValidChannel("a/b")).toBe(false);
		expect(isValidChannel(".hidden")).toBe(false);
		expect(isValidChannel("-lead")).toBe(false);
		expect(isValidChannel("x".repeat(65))).toBe(false);
	});
});

describe("messageFilename", () => {
	it("sorts chronologically, then by sequence within one millisecond", () => {
		const early = messageFilename("2026-08-11T10:00:00.000Z", SENDER_A, 3);
		const sameMsLater = messageFilename("2026-08-11T10:00:00.000Z", SENDER_A, 4);
		const later = messageFilename("2026-08-11T10:00:01.000Z", SENDER_A, 0);
		expect([later, sameMsLater, early].sort()).toEqual([early, sameMsLater, later]);
	});
});

describe("write/parse round-trip", () => {
	it("preserves every field", () => {
		const message = sampleMessage();
		const path = writeMessage(dir, message, 0);
		expect(parseMessage(readFileSync(path, "utf8"))).toEqual(message);
	});

	it("omits alias cleanly when absent", () => {
		const message = sampleMessage();
		delete message.alias;
		const path = writeMessage(dir, message, 0);
		const parsed = parseMessage(readFileSync(path, "utf8"));
		expect(parsed).toEqual(message);
		expect(parsed && "alias" in parsed).toBe(false);
	});

	it("rejects malformed JSON, wrong schema, and missing fields", () => {
		expect(parseMessage("not json")).toBeUndefined();
		expect(parseMessage(JSON.stringify({ ...sampleMessage(), schema: "other/v1" }))).toBeUndefined();
		expect(parseMessage(JSON.stringify({ ...sampleMessage(), sender: "" }))).toBeUndefined();
		expect(parseMessage(JSON.stringify({ ...sampleMessage(), text: 7 }))).toBeUndefined();
		expect(parseMessage(JSON.stringify({ ...sampleMessage(), channel: "../x" }))).toBeUndefined();
	});
});

describe("collectNew", () => {
	it("delivers the full backlog on first scan and only newer files after", () => {
		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:00.000Z", text: "one" }), 0);
		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:01.000Z", text: "two" }), 1);

		const first = collectNew(dir, "dev", undefined, SENDER_B);
		expect(first.messages.map((m) => m.text)).toEqual(["one", "two"]);

		const second = collectNew(dir, "dev", first.cursor, SENDER_B);
		expect(second.messages).toEqual([]);
		expect(second.cursor).toBe(first.cursor);

		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:02.000Z", text: "three" }), 2);
		const third = collectNew(dir, "dev", second.cursor, SENDER_B);
		expect(third.messages.map((m) => m.text)).toEqual(["three"]);
	});

	it("filters the reader's own messages but still advances the cursor past them", () => {
		writeMessage(dir, sampleMessage({ sender: SENDER_B, text: "mine" }), 0);
		const collected = collectNew(dir, "dev", undefined, SENDER_B);
		expect(collected.messages).toEqual([]);
		expect(collected.cursor).toBeDefined();
	});

	it("skips corrupt files without stalling the cursor", () => {
		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:00.000Z", text: "good" }), 0);
		writeFileSync(join(channelDir(dir, "dev"), "2026-08-11T10-00-01-000Z_zzzzzzzz_0000.json"), "garbage");

		const collected = collectNew(dir, "dev", undefined, SENDER_B);
		expect(collected.messages.map((m) => m.text)).toEqual(["good"]);
		// Cursor sits past the corrupt file, so it is not rescanned forever.
		expect(collected.cursor).toBe("2026-08-11T10-00-01-000Z_zzzzzzzz_0000.json");
	});

	it("returns nothing for a channel that does not exist", () => {
		const collected = collectNew(dir, "ghost-town", undefined, SENDER_B);
		expect(collected.messages).toEqual([]);
		expect(collected.cursor).toBeUndefined();
	});
});

describe("listChannels / clearChannel", () => {
	it("lists channel directories and clears message files", () => {
		writeMessage(dir, sampleMessage({ channel: "dev" }), 0);
		writeMessage(dir, sampleMessage({ channel: "game" }), 1);
		expect(listChannels(dir)).toEqual(["dev", "game"]);

		expect(clearChannel(dir, "dev")).toBe(1);
		expect(listMessageFiles(dir, "dev")).toEqual([]);
		expect(listChannels(dir)).toEqual(["game"]);
		expect(clearChannel(dir, "missing")).toBe(0);
	});

	it("leaves unknown files in place when clearing", () => {
		writeMessage(dir, sampleMessage(), 0);
		const stray = join(channelDir(dir, "dev"), "README.txt");
		writeFileSync(stray, "keep me");
		clearChannel(dir, "dev");
		expect(existsSync(stray)).toBe(true);
	});
});

describe("ensureGitExclude", () => {
	function initRepo(root: string): void {
		const result = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
		expect(result.status).toBe(0);
	}

	it("appends the starred entry once, idempotently", () => {
		initRepo(dir);
		ensureGitExclude(dir);
		ensureGitExclude(dir);
		const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
		const hits = exclude.split("\n").filter((line) => line === "**/.pi/intercom/");
		expect(hits).toHaveLength(1);
	});

	it("is a no-op outside a git repo", () => {
		const bare = mkdtempSync(join(tmpdir(), "pi-intercom-bare-"));
		try {
			ensureGitExclude(bare);
			expect(existsSync(join(bare, ".git"))).toBe(false);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("covers subdirectory cwds through the shared repo exclude", () => {
		initRepo(dir);
		const nested = join(dir, "apps", "web");
		mkdirSync(nested, { recursive: true });
		ensureGitExclude(nested);
		const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
		expect(exclude).toContain("**/.pi/intercom/");
	});
});

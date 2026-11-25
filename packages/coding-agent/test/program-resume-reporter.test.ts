import { createHash } from "node:crypto";
import type { ProgramResumeCommand, Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramResumeReporter } from "../src/modes/interactive/program-resume-reporter.ts";

const TOKEN = "test-token-0123456789abcdef";

type Report = { kind: "resume"; argv: string[]; cwd?: string } | { kind: "clear" };

/** Decode a report and check its mac, pid and time like a terminal would. */
function decode(sequence: string): Report {
	const match = /^\x1b\]7577;(.*):mac=([0-9a-f]{64})\x1b\\$/.exec(sequence);
	expect(match).not.toBeNull();
	const [, body, mac] = match!;
	expect(createHash("sha256").update(`${body}:${TOKEN}`).digest("hex")).toBe(mac);
	const pairs = new Map(body.split(":").map((pair) => pair.split("=", 2) as [string, string]));
	expect(pairs.get("pid")).toBe(String(process.pid));
	expect(pairs.get("time")).toBe(String(Math.floor(Date.now() / 1000)));
	if (pairs.get("clear") === "1") return { kind: "clear" };
	const decodeText = (value: string) => Buffer.from(value, "base64").toString("utf8");
	const cwd = pairs.get("cwd");
	return {
		kind: "resume",
		argv: body
			.match(/(?:^|:)argv=([^:]*)/)![1]
			.split(",")
			.map(decodeText),
		...(cwd === undefined ? {} : { cwd: decodeText(cwd) }),
	};
}

function setup(initial?: ProgramResumeCommand) {
	const writes: string[] = [];
	const terminal = { write: (data: string) => writes.push(data) } as unknown as Terminal;
	const state: { command: ProgramResumeCommand | undefined } = { command: initial };
	const reporter = new ProgramResumeReporter(
		TOKEN,
		() => terminal,
		() => state.command,
	);
	const reports = () => writes.map(decode);
	return { reporter, state, reports };
}

const session = (id: string): ProgramResumeCommand => ({ argv: ["pi", "--session", id], cwd: "/home/user/project" });

describe("ProgramResumeReporter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports the resume command with an authenticated pid and time", () => {
		const { reporter, reports } = setup(session("a"));
		reporter.report();
		expect(reports()).toEqual([{ kind: "resume", ...session("a") }]);
	});

	it("reports only when the command changes", () => {
		const { reporter, state, reports } = setup(session("a"));
		reporter.report();
		reporter.report();
		state.command = session("b");
		reporter.report();
		expect(reports()).toEqual([
			{ kind: "resume", ...session("a") },
			{ kind: "resume", ...session("b") },
		]);
	});

	it("sends nothing until there is a session to resume, and clears when it goes away", () => {
		const { reporter, state, reports } = setup();
		reporter.report();
		expect(reports()).toEqual([]);
		state.command = session("a");
		reporter.report();
		// For example /new: the new session has no file until its first message.
		state.command = undefined;
		reporter.report();
		expect(reports()).toEqual([{ kind: "resume", ...session("a") }, { kind: "clear" }]);
	});

	it("reports an unchanged command again after a suspend", () => {
		const { reporter, reports } = setup(session("a"));
		reporter.report();
		reporter.reportAgain();
		expect(reports()).toEqual([
			{ kind: "resume", ...session("a") },
			{ kind: "resume", ...session("a") },
		]);
	});

	it("does not report again when there was and is nothing to resume", () => {
		const { reporter, reports } = setup();
		reporter.reportAgain();
		expect(reports()).toEqual([]);
	});

	it("clears the command on quit, once", () => {
		const { reporter, reports } = setup(session("a"));
		reporter.clear();
		expect(reports()).toEqual([]);
		reporter.report();
		reporter.clear();
		reporter.clear();
		expect(reports()).toEqual([{ kind: "resume", ...session("a") }, { kind: "clear" }]);
	});

	it("clears instead of reporting a command the protocol cannot carry", () => {
		const { reporter, state, reports } = setup(session("a"));
		reporter.report();
		state.command = { argv: ["pi", "--session", "a"], cwd: "/home/user/line\nbreak" };
		reporter.report();
		expect(reports()).toEqual([{ kind: "resume", ...session("a") }, { kind: "clear" }]);
	});
});

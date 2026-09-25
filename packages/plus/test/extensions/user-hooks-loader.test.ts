/**
 * Tests for plus/src/extensions/hooks/loader.ts — parsing the "hooks" key
 * of settings.json (CC v2 format) and matcher semantics (exact, regex,
 * aliases, match-all).
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { matcherMatches, parseSettingsHooks, TOOL_NAME_ALIASES } from "../../src/extensions/hooks/loader.ts";

describe("matcherMatches", () => {
	it("matches every tool when the matcher is absent or empty", () => {
		assert.equal(matcherMatches(undefined, "bash"), true);
		assert.equal(matcherMatches("", "bash"), true);
	});

	it("matches the exact tool name", () => {
		assert.equal(matcherMatches("bash", "bash"), true);
		assert.equal(matcherMatches("bash", "read"), false);
	});

	it("matches canonical-name aliases (ask_user ↔ AskUserQuestion)", () => {
		assert.ok(TOOL_NAME_ALIASES.ask_user.includes("AskUserQuestion"));
		assert.equal(matcherMatches("AskUserQuestion", "ask_user"), true);
		assert.equal(matcherMatches("AskUserQuestion", "bash"), false);
	});

	it("supports /regex/ matchers against the tool name", () => {
		assert.equal(matcherMatches("/^Ask/", "ask_user"), true);
		assert.equal(matcherMatches("/^Ask/", "bash"), false);
		assert.equal(matcherMatches("/read|write/", "write"), true);
	});

	it("falls back to exact comparison on invalid regex", () => {
		assert.equal(matcherMatches("/[invalid/", "bash"), false);
		assert.equal(matcherMatches("/[invalid/", "/[invalid/"), true);
	});
});

describe("parseSettingsHooks", () => {
	it("returns nothing when there is no hooks key", () => {
		assert.deepEqual(parseSettingsHooks({}), []);
		assert.deepEqual(parseSettingsHooks({ hooks: {} }), []);
		assert.deepEqual(parseSettingsHooks(undefined), []);
		assert.deepEqual(parseSettingsHooks("nonsense"), []);
	});

	it("parses per-event groups with matcher, command, async, and metadata", () => {
		const hooks = parseSettingsHooks({
			hooks: {
				PermissionRequest: [{ hooks: [{ _id: "ask-notify", type: "command", command: "/h/ask.sh", async: true }] }],
				Stop: [
					{
						matcher: "AskUserQuestion",
						hooks: [{ _source: "agent-captain", type: "command", command: { bash: "/h/stop.sh" } }],
					},
				],
			},
		});
		assert.equal(hooks.length, 2);
		const ask = hooks[0];
		assert.equal(ask.event, "PermissionRequest");
		assert.equal(ask.matcher, undefined);
		assert.equal(ask.command, "/h/ask.sh");
		assert.equal(ask.async, true);
		assert.equal(ask.id, "ask-notify");
		const stop = hooks[1];
		assert.equal(stop.event, "Stop");
		assert.equal(stop.matcher, "AskUserQuestion");
		assert.equal(stop.command, "/h/stop.sh"); // {bash: ...} unwrapped
		assert.equal(stop.async, true); // async defaults to true
		assert.equal(stop.source, "agent-captain");
	});

	it("skips non-command entries, missing commands, and malformed shapes", () => {
		const hooks = parseSettingsHooks({
			hooks: {
				Stop: [
					{ hooks: [{ type: "prompt" }, { type: "command" }, { type: "command", command: 42 }, "garbage", null] },
					"garbage-group",
					{ hooks: "not-an-array" },
				],
			},
		});
		assert.deepEqual(hooks, []);
	});

	it("treats async: false as blocking metadata (still fired fire-and-forget)", () => {
		const hooks = parseSettingsHooks({
			hooks: { Stop: [{ hooks: [{ type: "command", command: "/h.sh", async: false }] }] },
		});
		assert.equal(hooks[0].async, false);
	});
});

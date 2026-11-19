import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function makeSession(id: string, text: string, modified: number): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "",
		created: new Date(0),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: text,
		allMessagesText: text,
	};
}

async function createSelector(sessions: SessionInfo[], selected: string[]) {
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		(path) => selected.push(path),
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager() },
	);
	await flushPromises();
	return selector.getSessionList();
}

describe("session selector search selection", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	// Regression test for #12245: the /login fix applied to /resume.
	it("selects the best match after typing a query, even after scrolling", async () => {
		const sessions = [
			makeSession("login", "fix login", 6000),
			makeSession("logout", "fix logout", 5000),
			makeSession("refactor", "refactor", 4000),
			makeSession("docs", "docs", 3000),
			makeSession("tests", "tests", 2000),
		];
		const selected: string[] = [];
		const list = await createSelector(sessions, selected);

		for (let i = 0; i < 4; i++) list.handleInput("\x1b[B");
		expect(list.getSelectedSessionPath()).toBe("/tmp/tests.jsonl");
		for (const char of "fix") list.handleInput(char);
		list.handleInput("\r");

		expect(selected).toEqual(["/tmp/login.jsonl"]);
	});

	it("keeps the top row selected when sessions arrive after typing a query", async () => {
		const sessions = [makeSession("login", "fix login", 6000), makeSession("docs", "docs", 3000)];
		const list = await createSelector(sessions, []);

		list.handleInput("\x1b[B");
		for (const char of "fix") list.handleInput(char);
		list.setSessions([makeSession("newer", "fix newer", 7000), ...sessions], false);

		expect(list.getSelectedSessionPath()).toBe("/tmp/newer.jsonl");
	});
});

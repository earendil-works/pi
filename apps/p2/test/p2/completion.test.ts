// `@` and Tab file completion (p2-tui-port.md sections 8.2-8.4): the shared text helpers (copies of pi-tui's), the
// TUI provider over a FileIndex, the editor integration, and the index's bounds on a large directory (P7a, P7b).

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import chatTui from "../../plugins/chat/tui.ts";
import { Drafts } from "../../plugins/drafts/contract.ts";
import { rankFiles, withDirectories } from "../../plugins/file-index/rank.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import {
	applyFileCompletion,
	atItems,
	extractAtPrefix,
	extractPathPrefix,
	outOfScope,
	pathItems,
} from "../../src/runtime/completion.ts";
import { FileIndex } from "../../src/runtime/file-index.ts";
import { FileCompletionProvider, type FileSource, OUT_OF_SCOPE_HINT } from "../../src/tui/completion.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { holdIn, poll, startFixture } from "./helpers.ts";
import { SESSION, type Stub, sessionsStub, topology } from "./tui-fixture.ts";

test("prefix extraction, quoting and insertion follow pi-tui", () => {
	assert.equal(extractAtPrefix("look at @src/ma"), "@src/ma");
	assert.equal(extractAtPrefix('see @"my fi'), '@"my fi');
	assert.equal(extractAtPrefix("mail me@example"), null, "not at a token start");
	assert.equal(extractAtPrefix("(@src"), "@src", "opening wrappers are stripped");
	assert.equal(extractPathPrefix("edit src/ma"), "src/ma");
	assert.equal(extractPathPrefix("hello"), null);
	assert.equal(extractPathPrefix("hello", true), "hello", "forced Tab takes any token");
	for (const prefix of ["/etc", "~", "~/x", "..", "../x"]) assert(outOfScope(prefix), prefix);
	assert(!outOfScope("src") && !outOfScope(".env") && !outOfScope("./src"));
	assert.deepEqual(atItems([{ path: "my dir/a b.ts", dir: false }], { isQuotedPrefix: false }), [
		{ value: '@"my dir/a b.ts"', label: "a b.ts", description: "my dir/a b.ts" },
	]);
	assert.deepEqual(
		pathItems(
			[
				{ name: "main.ts", dir: false },
				{ name: "maps", dir: true },
				{ name: "other.ts", dir: false },
			],
			"src/ma",
			{ isAtPrefix: false, isQuotedPrefix: false },
		),
		[
			{ value: "src/maps/", label: "maps/" },
			{ value: "src/main.ts", label: "main.ts" },
		],
	);
	// Files after `@` get a trailing space; directories none (completion continues).
	assert.deepEqual(applyFileCompletion("see @sr now", 7, { value: "@src/a.ts", label: "a.ts" }, "@sr"), {
		line: "see @src/a.ts  now",
		cursorCol: 14,
	});
	assert.deepEqual(applyFileCompletion("@sr", 3, { value: "@src/", label: "src/" }, "@sr"), {
		line: "@src/",
		cursorCol: 5,
	});
});

test("the TUI provider: @ asks the index, Tab lists the directory, / goes to commands, outside the cwd hints", async () => {
	const calls: string[] = [];
	const hints: string[] = [];
	const files: FileSource = {
		complete: async ({ query }) => {
			calls.push(`complete:${query}`);
			return {
				items: rankFiles(withDirectories(["src/app.ts", "src/main.ts", "README.md"]), query),
				truncated: true,
			};
		},
		list: async ({ path }) => {
			calls.push(`list:${path}`);
			return { entries: [{ name: "app.ts", dir: false }], truncated: false };
		},
	};
	const slash = {
		getSuggestions: async () => ({ items: [{ value: "model", label: "model" }], prefix: "/mo" }),
		applyCompletion: (lines: string[]) => ({ lines: [`${lines[0]}!`], cursorLine: 0, cursorCol: 0 }),
	};
	const provider = new FileCompletionProvider(
		slash,
		() => files,
		(text) => hints.push(text),
	);
	const signal = new AbortController().signal;
	const at = await provider.getSuggestions(["fix @app"], 0, 8, { signal });
	assert.deepEqual(at?.items[0], { value: "@src/app.ts", label: "app.ts", description: "src/app.ts" });
	assert.equal(at?.prefix, "@app");
	assert(
		hints.some((hint) => /partial/.test(hint)),
		"a truncated index is surfaced",
	);
	const applied = provider.applyCompletion(["fix @app"], 0, 8, at!.items[0]!, "@app");
	assert.deepEqual(applied, { lines: ["fix @src/app.ts "], cursorLine: 0, cursorCol: 16 });
	const tab = await provider.getSuggestions(["open src/a"], 0, 10, { signal, force: true });
	assert.deepEqual(tab, { items: [{ value: "src/app.ts", label: "app.ts" }], prefix: "src/a" });
	assert.deepEqual(await provider.getSuggestions(["/mo"], 0, 3, { signal }), {
		items: [{ value: "model", label: "model" }],
		prefix: "/mo",
	});
	assert.deepEqual(provider.applyCompletion(["/mo"], 0, 3, { value: "model", label: "model" }, "/mo").lines, ["/mo!"]);
	assert.equal(await provider.getSuggestions(["see @~/x"], 0, 8, { signal }), null);
	assert.equal(await provider.getSuggestions(["cat ../x"], 0, 8, { signal, force: true }), null);
	assert.equal(hints.filter((hint) => hint === OUT_OF_SCOPE_HINT).length, 2);
	assert(!provider.shouldTriggerFileCompletion(["/mod"], 0, 4));
	assert(provider.shouldTriggerFileCompletion(["/model src"], 0, 10));
	assert.deepEqual(calls, ["complete:app", "list:src"]);
});

test("in the chat editor, @ completes from the session's FileIndex and inserts the path", async (t) => {
	const view = { conversation: { id: ROOT_CONVERSATION_ID }, entries: [], docs: {} };
	const worker: Stub[] = [
		[
			Chat,
			(_input, _principal, self) => ({
				variant: "participant",
				view: self.state(view as never),
				model: self.state(null),
				liveShell: self.state(null),
				stats: self.state(null),
				entries: () => ({ items: [], more: false }),
				send: () => ({ submissionId: 1 }),
				stop: () => ({ restored: [] }),
				dequeue: () => ({ text: null }),
				configure: () => {},
				compact: () => ({ taskId: 1 }),
				abortCompaction: () => ({ aborted: 0 }),
				reset: () => {},
				shell: () => ({ shellId: "shell-1" }),
				abortShell: () => ({ aborted: false }),
				dequeueOwn: () => ({ restored: [], skipped: 0 }),
			}),
		],
		[
			Drafts,
			(_input, _principal, self) => ({
				variant: "author",
				drafts: self.state([]),
				claim: () => ({ texts: [] }),
			}),
		],
		[
			FileIndex,
			(_input, _principal, self) => ({
				variant: "reader",
				changes: self.state(0),
				complete: ({ query }: { query: string }) => ({
					items: rankFiles(withDirectories(["src/parser.ts", "docs/guide.md"]), query),
					truncated: false,
				}),
				list: () => ({ entries: [], truncated: false }),
			}),
		],
	];
	const { runtime, screen, send } = await topology(t, {
		server: [sessionsStub(SESSION)],
		worker,
		facets: [tuiCoreFacet, chatTui],
	});
	runtime.navigate("chat", "s");
	await poll(async () => !(await screen()).includes("Connecting conversation"));
	for (const char of "fix @pars") send(char);
	await poll(async () => (await screen()).includes("src/parser.ts"));
	send("\t");
	await poll(() => runtime.drafts.get("s#1") === "fix @src/parser.ts ");
});

test("the index stays within its bounds on a large directory and says so", { timeout: 120_000 }, async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	// More entries than either source lists: the daemon's listFiles (50 000 entries) and the bounded fallback walk
	// (5000 directories) both truncate.
	for (let index = 0; index < 50_100; index++) {
		const dir = join(fixture.workspace, `d${index}`);
		mkdirSync(dir);
		if (index % 500 === 0) writeFileSync(join(dir, `file${index}.ts`), "");
	}
	const owner = fixture.browser();
	const session = (
		await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
	).id;
	const index = owner.hold(FileIndex, { session, conversation: 1 }, BACKGROUND_CONTEXT);
	await whenLive(index);
	const started = Date.now();
	const result = await index.complete({ query: "file", limit: 100 }, BACKGROUND_CONTEXT);
	assert.equal(result.truncated, true);
	assert(result.items.length > 0 && result.items.length <= 100);
	assert(result.items.every((item) => item.path.includes("file")));
	// Both sources keep the first names in byte order whatever the filesystem's directory order (the daemon depth first,
	// the walk breadth first), so d0/file0.ts is in the index. Ranked: name prefix matches first, shallow and short
	// paths first among equals.
	assert.deepEqual(result.items[0], { path: "d0/file0.ts", dir: false });
	const again = Date.now();
	await index.complete({ query: "file4", limit: 5 }, BACKGROUND_CONTEXT);
	assert(Date.now() - again < Date.now() - started + 1000, "the cached index answers");
});

// docs/workflows.md: every pattern script runs in code mode against p2's tools (fake provider). The fake answers a
// one-shot agent with a small value matching its schema; real model names become the fake model, and the repository
// path the test workspace. Also checks the doc's claim about `tools.bash` errors.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const doc = readFileSync(new URL("../../docs/workflows.md", import.meta.url), "utf8");
const blocks = [...doc.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const results = (view: ConversationView | null | undefined) =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
		),
	);
const text = (message: ToolResultMessage) =>
	message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

describe("workflow patterns (docs/workflows.md)", () => {
	let fixture: Fixture;
	let chat: RefIn<typeof Chat, "participant">;
	let runs = 0;
	/** Runs `script` as one code mode call; resolves to its result (parsed JSON when it is JSON). */
	const run = async (script: string): Promise<unknown> => {
		const before = runs++;
		await chat.send({ text: `codemode ${script}`, requestId: `workflow-${before}` }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => results(value).length > before && !live(value)?.run, 60_000);
		const result = results(view)[before]!;
		assert.equal(result.isError, false, text(result));
		// Durable's coding-agent layout: a "Script completed" header, then the script's output and returned value.
		const output = text(result).replace(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n?/, "");
		assert.notEqual(output, text(result), `a completed script's result: ${text(result)}`);
		try {
			return JSON.parse(output);
		} catch {
			return output;
		}
	};
	const adapt = (script: string) =>
		script.replaceAll("/abs/path/to/repo", fixture.workspace).replace(/model: "[^"]+"/g, 'model: "faux/faux-1"');

	before(async () => {
		fixture = await startFixture();
		const owner = fixture.browser();
		const session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
	});
	after(async () => {
		await fixture?.close();
	});

	it("has the call signature and four pattern scripts", () => {
		assert.equal(blocks.length, 5);
		assert.match(blocks[0]!, /await tools\.agent\(\{/);
		// The tools the doc names are p2's coding tools.
		for (const tool of ["read", "write", "edit", "bash", "send_file", "artifact"])
			assert.ok(doc.includes(tool), tool);
	});

	it("fans out, then adversarially verifies", async () => {
		const value = (await run(adapt(blocks[1]!))) as Record<string, unknown>;
		// One finding per reviewer (severity "high"), each confirmed by its verifier.
		assert.deepEqual(Object.keys(value).sort(), ["confirmed", "refuted", "reviewerErrors", "unsure"]);
		assert.equal((value.confirmed as unknown[]).length, 2);
		assert.equal(value.refuted, 0);
		assert.deepEqual(value.reviewerErrors, []);
	});

	it("drafts from several angles, then judges", async () => {
		const value = (await run(adapt(blocks[2]!))) as { summaries: unknown[]; verdict: Record<string, unknown> };
		assert.equal(value.summaries.length, 3);
		assert.deepEqual(Object.keys(value.verdict).sort(), ["merged", "rejected", "steps", "winner"]);
	});

	it("fixes until a check passes, stopping without progress", async () => {
		// The workspace has no package.json: `npm run check` fails the same way every round.
		const value = (await run(adapt(blocks[3]!))) as Record<string, unknown>;
		assert.equal(value.passed, false);
		assert.equal(value.reason, "two rounds without progress");
		assert.equal(typeof value.output, "string");
	});

	it("searches in rounds until nothing new turns up", async () => {
		const value = (await run(adapt(blocks[4]!))) as { id: string }[];
		assert.equal(value.length, 1);
	});

	it("gives a failed bash call's structured output to the script, as the fix pattern relies on", async () => {
		// A schema tool's error result with its own value resolves (Durable code mode): the script reads the exit code
		// directly; the fix pattern's `.catch` stays a fallback for calls that fail without one.
		const value = await run(
			'try { const check = await tools.bash({ command: "printf failing; exit 3" }); return { resolved: true, ...check }; } catch (error) { return { resolved: false, ...error.structuredOutput }; }',
		);
		const result = value as { resolved: boolean; output: string; exitCode: number };
		assert.deepEqual(
			{ resolved: result.resolved, output: result.output, exitCode: result.exitCode },
			{ resolved: true, output: "failing", exitCode: 3 },
		);
	});
});

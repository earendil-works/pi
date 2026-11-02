import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineTool, ToolResultEntry, ToolTask, type ToolTaskInput } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { CodemodeRunDoc, createCodemodeTool, setCodemodeInputWait } from "../src/codemode/codemode.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred, eventually } from "./task-support.ts";

it("retains overlapping human waits across restart and counts execution time again after the last decision", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-input-wait-"));
	const path = join(directory, "session.sqlite");
	const setup = chatSetup();
	const sandbox = new CodemodeSandbox();
	const entered = deferred();
	const released = deferred();
	let runs = 0;
	let effects = 0;
	addTool(setup.registry, createCodemodeTool({ sandbox }));
	addTool(
		setup.registry,
		defineTool({
			name: "approve",
			description: "Human approval",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_args, _api, callContext) => {
				runs++;
				entered.resolve();
				await Promise.race([released.promise, aborted(callContext.abortSignal!)]);
				effects++;
				return { output: [{ type: "text", text: "approved" }] };
			},
		}),
	);
	setup.faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("codemode", { code: '// @options: {"timeout_ms": 1000}\nreturn await tools.approve({});' })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	let opened = await openChat(await openNodeSqliteStorage(path), setup);
	try {
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await entered.promise;
		const task = (
			await opened.harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)
		).items.find((candidate) => (candidate.input as ToolTaskInput).kind === "model")!;
		const wait = (id: string, waiting: boolean) =>
			opened.harness.commit((tx) => setCodemodeInputWait(tx, task.id, id, waiting), context);
		const before = (await opened.harness.snapshot(CodemodeRunDoc, task.id, context))!.start!.deadline!;
		expect(await wait("a", true)).toBe(true);
		expect(await wait("b", true)).toBe(true);
		const pausedAt = (await opened.harness.snapshot(CodemodeRunDoc, task.id, context))!.inputWaitStartedAt!;
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect((await opened.harness.snapshot(CodemodeRunDoc, task.id, context))!.result).toBeUndefined();
		await opened.harness.close(context);
		const clock = vi.spyOn(Date, "now").mockReturnValue(pausedAt + 86_400_000);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		await eventually(() => runs === 2);
		expect(await wait("a", false)).toBe(true);
		expect(await wait("a", true)).toBe(true); // Late retry cannot reopen a resolved wait.
		expect(await wait("b", true)).toBe(true); // Duplicate cannot move the pause boundary.
		expect((await opened.harness.snapshot(CodemodeRunDoc, task.id, context))!.inputWaitStartedAt).toBe(pausedAt);
		expect(await wait("b", false)).toBe(true);
		const resumed = (await opened.harness.snapshot(CodemodeRunDoc, task.id, context))!;
		expect(resumed.inputWaitStartedAt).toBeUndefined();
		expect(resumed.start!.deadline).toBe(before + 86_400_000);
		expect(await wait("b", false)).toBe(true);
		expect((await opened.harness.snapshot(CodemodeRunDoc, task.id, context))!.start!.deadline).toBe(
			resumed.start!.deadline,
		);
		released.resolve();
		expect((await (await opened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
		const result = (await allEntries(opened.root)).find((entry) => ToolResultEntry.is(entry))!;
		expect(result.model![0]).toMatchObject({ role: "toolResult", isError: false });
		expect(effects).toBe(1);
		clock.mockRestore();
	} finally {
		vi.restoreAllMocks();
		await opened.harness.close(context);
		await sandbox.close();
		await rm(directory, { recursive: true, force: true });
	}
});

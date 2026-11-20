// The memory test's session (`release/memory.test.ts`), run in a session worker (`test/memory/worker.ts`) as slice 3
// will run one there: Durable's `Harness` on the worker's store, the coding tools (read, write, edit, bash; Photon
// images), a `NodeExecutionEnv`, a prompt section, a subagent tool, pi-ai's real Anthropic and OpenAI providers pointed
// at the test's HTTPS stub, and telemetry recorded and sent to the server every second. Then the schedule: idle, one
// streamed answer, a burst of 20 turns with tool calls and a change of provider, five subagent conversations streaming
// at once; idle between. Each phase is a line in the file `P3_MEMORY_PHASES` names, for the test to read; after an idle
// phase's line the worker waits until the test sends it `SIGUSR2` (its memory settled), so the worker does nothing
// meanwhile: no timer of its own keeps V8 from shrinking its heap.

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { sendWorkerTelemetry, TelemetryRecorder } from "@earendil-works/chord/telemetry-ingest";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, defineExtension, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import type { WorkerSession } from "../../src/kit/worker.ts";
import { words } from "./stub.ts";

/** How many subagent conversations stream at once in the last phase. */
export const SUBAGENTS = 5;

/** Runs the schedule on `worker`; a failure is a phase `error …`. */
export async function runSession({ store, host }: WorkerSession, context: Context): Promise<void> {
	const phases = process.env.P3_MEMORY_PHASES!;
	// The test's go-aheads, counted: one may come before the wait for it starts.
	let go = 0;
	let wake: (() => void) | undefined;
	process.on("SIGUSR2", () => {
		go += 1;
		wake?.();
	});
	let waited = 0;
	const settle = async () => {
		waited += 1;
		while (go < waited) {
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	};
	const mark = (phase: string) =>
		appendFileSync(phases, `${JSON.stringify({ pid: process.pid, phase, t: Date.now() })}\n`);
	try {
		// Telemetry as the kit will run it: a recorder the harness records into, sent to the server every second.
		const scope = crypto.randomUUID();
		const recorder = new TelemetryRecorder(() => scope, 10_000);
		const sender = sendWorkerTelemetry(host, recorder, context);
		setInterval(() => void sender.send(false), 1000).unref();
		// Under the test's directory, which the test removes.
		const cwd = mkdtempSync(join(dirname(phases), "cwd-"));
		writeFileSync(join(cwd, "main.ts"), words(20_000));
		const models = createModels();
		const stub = process.env.P3_MEMORY_STUB!;
		// The real providers, their key and base URL the stub's.
		const point = <P extends ReturnType<typeof anthropicProvider> | ReturnType<typeof openaiProvider>>(
			provider: P,
			baseUrl: string,
		): P => ({
			...provider,
			auth: {
				apiKey: { name: "stub", resolve: async () => ({ auth: { apiKey: "stub-key", baseUrl }, source: "stub" }) },
			},
		});
		models.setProvider(point(anthropicProvider(), stub));
		models.setProvider(point(openaiProvider(), `${stub}/v1`));
		const anthropic = { provider: "anthropic", modelId: anthropicProvider().getModels()[0]!.id };
		const openai = { provider: "openai", modelId: openaiProvider().getModels()[0]!.id };
		const registry = createRegistry();
		registry.install(createCodingTools({ images: await createNodePhotonImages() }));
		registry.install(
			defineExtension({
				name: "p3-coding",
				sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
			}),
		);
		// Subagents as Durable's README and p2 run them: a tool creates a task-owned child conversation and waits for it.
		registry.install(
			defineExtension({
				name: "subagent",
				tools: [
					defineTool({
						name: "subagent",
						description: "Delegate a self-contained task to a subagent and get its answer back.",
						parameters: obj({ task: str() }),
						replay: "safe",
						execute: async (args, api, ctx) => {
							const child = await api.commit(async (tx) => {
								const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
								if (existing !== undefined) return existing.id;
								return (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id;
							}, ctx);
							const request = {
								type: "input",
								content: args.task,
								requestId: `subagent:${api.taskId}`,
							} as const;
							const settled = await (await (await api.conversation(child, ctx))!.submit(request, ctx)).wait(ctx);
							return { output: [{ type: "text", text: settled.status }] };
						},
					}),
				],
			}),
		);
		const harness = await Harness.open(
			await StoreStorage.open(store, "harness", context),
			{
				models,
				registry,
				telemetry: recorder,
				env: ({ cwd: at }) => new NodeExecutionEnv({ cwd: at ?? cwd }),
				onReport: (report) => console.error("durable:", report.kind, report.error),
				settings: { toolExecution: "parallel" },
			},
			context,
		);
		const root = await harness.root(context, { agent: { model: anthropic, cwd } });
		const turn = async (tag: string, i: number) => {
			const submission = await root.submit(
				{ type: "input", content: `${tag} question ${i}: ${words(400)}` },
				context,
			);
			const settled = await submission.wait(context);
			if (settled.status !== "done") throw new Error(`turn ${i} ${tag}: ${JSON.stringify(settled).slice(0, 400)}`);
		};
		mark("idle");
		await settle();
		mark("stream");
		await turn("[stream]", 0);
		mark("streamed");
		await settle();
		mark("burst");
		for (let i = 1; i <= 20; i++) {
			// Five turns on the other provider: both SDKs load.
			if (i === 11) await root.configure({ model: openai }, context);
			if (i === 16) await root.configure({ model: anthropic }, context);
			await turn(i >= 11 && i <= 15 ? "[text]" : ["[tool:read]", "[tool:bash]", "[text]"][i % 3]!, i);
		}
		mark("bursted");
		await settle();
		mark("subagents");
		await turn(`[spawn:${SUBAGENTS}]`, 21);
		mark("subagented");
		await settle();
		mark("done");
	} catch (error) {
		mark(`error ${String((error as Error)?.stack ?? error).slice(0, 800)}`);
	}
}

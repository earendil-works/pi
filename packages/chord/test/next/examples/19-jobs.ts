// Jobs: owned work a call starts that outlives the call, in Durable's sandwich: intent (`start`, one transaction), run
// (any effect, outside transactions) and finish (one transaction on the current code, with the cleanup). Here a shell
// job of a shared chat store: its state document carries the output, throttled by the author and flushed in a
// `finally`, so the last output reaches `outcome.state` after an abort too; `running` is ordinary state, which
// per-principal views filter (a guest sees no output); `finish` records an entry and chains a second job.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/19-jobs.ts
import { BACKGROUND_CONTEXT, type Context } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, remote, type Static, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, sleep } from "../../../src/next/host/index.ts";
import { defineJob } from "../../../src/next/jobs/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { mapShared } from "../../../src/next/state/index.ts";
import { OutputBuffer, Progress } from "../../../src/output.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "guest" } | { kind: "server" };

// 1. The job: closed args (checked at every start), a result, a state document per run, one run at a time.
const ShellState = defineState("example.shell.state", {
	schema: obj({ output: str() }),
	version: 1,
	initial: () => ({ output: "" }),
});
const ShellJob = defineJob("example.shell", {
	version: 1,
	args: obj({ command: str(), lines: int() }),
	result: obj({ exit: int(), output: str() }),
	state: ShellState,
	concurrency: 1,
});
/** A second job `finish` chains: it announces a finished command. */
const NotifyJob = defineJob("example.notify", { version: 1, args: obj({ text: str() }), result: str() });

const Entries = defineState("example.entries", {
	schema: obj({ list: arr(str()) }),
	version: 1,
	initial: () => ({ list: [] }),
});

/** A shell as its owner sees it; a guest's view has no output. */
const Shell = obj({ id: str(), phase: str(), command: str(), output: str() });
const GuestShell = obj({ id: str(), phase: str(), command: str() });

/** The shared store: the entries and the shells once, whoever views them (§6). */
const ChatStore = local("example.chat-store", {
	version: 1,
	params: {},
	members: {
		entries: arr(str()),
		shells: arr(Shell),
		runShell: method(obj({ command: str(), lines: int(), requestId: str() }), str()),
		abortShell: method(obj({ id: str() })),
	},
});

/** Per-principal views: the owner runs shells and sees their output, a guest sees which shells run. */
const Chat = remote("example.chat", {
	version: 1,
	params: {},
	variants: {
		owner: {
			state: { entries: arr(str()), shells: arr(Shell) },
			methods: {
				runShell: method(obj({ command: str(), lines: int(), requestId: str() }), str()),
				abortShell: method(obj({ id: str() })),
			},
		},
		guest: { state: { entries: arr(str()), shells: arr(GuestShell) } },
	},
});

/** A fake process: one line every 30 ms; `sleep` rejects when the run is aborted. */
async function runProcess(lines: number, ctx: Context, onLine: (line: string) => void): Promise<number> {
	for (let n = 1; n <= lines; n++) {
		await sleep(30, ctx);
		onLine(`line ${n}\n`);
	}
	return 0;
}

const facet = defineFacet<P>((host) => {
	host.serve(ChatStore, (_, self) => {
		const entries = self.state(Entries);
		const notify = self.job(NotifyJob, {
			run: async ({ text }) => `notified: ${text}`,
			finish: async (outcome, tx) => {
				if (outcome.kind === "done") (await tx.draft(entries)).list.push(outcome.result);
			},
		});
		const shell = self.job(ShellJob, {
			run: async ({ lines }, ctx) => {
				// The output's bounds are required: a tail of at most 2,000 lines and 64 KiB.
				const out = new OutputBuffer({ maxBytes: 64 * 1024, maxLines: 2_000, retain: "tail" });
				// Every state change is a commit and, while watched, a message: the author throttles them (50 ms here).
				const write = async () => {
					const text = out.snapshot().text;
					await ctx.state.change((draft) => {
						draft.output = text;
					}, ctx);
					return text.length;
				};
				const progress = new Progress(write, (error) => console.error("progress failed:", error), 50);
				try {
					const exit = await runProcess(lines, ctx, (line) => {
						out.push(line);
						progress.mark();
					});
					return { exit, output: out.snapshot().text };
				} finally {
					// The last output reaches `outcome.state`, also after an abort (changes are taken until run settles).
					await progress.stop();
					await write();
				}
			},
			finish: async (outcome, tx) => {
				const { command } = outcome.args;
				const lines = outcome.state.output.split("\n").length - 1;
				const text =
					outcome.kind === "done"
						? `${command}: exit ${outcome.result.exit}, ${lines} lines`
						: `${command}: interrupted (${outcome.error.kind}), ${lines} lines kept`;
				(await tx.draft(entries)).list.push(text);
				// Chaining: the next job starts atomically with this outcome (both commit or neither).
				tx.start(notify, { text: command });
			},
		});
		// What the views read: one object per run, kept while the run's entry is the same object (`mapShared`).
		const toShell = mapShared(
			(entry: (typeof shell.running.value)[number]): Static<typeof Shell> =>
				entry.phase === "blocked"
					? { id: entry.id, phase: entry.phase, command: "?", output: "" }
					: { id: entry.id, phase: entry.phase, command: entry.args.command, output: entry.state.output },
		);
		return {
			entries: self.derive([entries], ([d]) => d.list),
			shells: self.derive([shell.running], ([running]) => toShell(running)),
			runShell: async ({ command, lines, requestId }, ctx) =>
				(await shell.start({ command, lines }, ctx, { key: requestId })).id,
			abortShell: async ({ id }) => {
				void shell.abort(id, context);
				return null;
			},
		};
	});
	host.serve(Chat, (_, principal, self) => {
		const store = self.get(ChatStore, {});
		if (principal.kind !== "owner") {
			// A guest sees no output: the view drops it (computed once per variant in a real store, §12).
			const strip = mapShared(
				(s: Static<typeof Shell>): Static<typeof GuestShell> => ({ id: s.id, phase: s.phase, command: s.command }),
			);
			return {
				variant: "guest",
				members: { entries: store.entries, shells: self.derive([store.shells], ([list]) => strip(list)) },
			};
		}
		return {
			variant: "owner",
			members: {
				entries: store.entries,
				shells: store.shells,
				runShell: (args, ctx) => store.runShell(args, ctx),
				abortShell: (args, ctx) => store.abortShell(args, ctx),
			},
		};
	});
});

// 2. A server and two tabs, the owner's and a guest's.
const server = createHost<P>({ principal: { kind: "server" }, onError: (error) => console.error(error) });
await server.load([{ name: "@example/chat", facet }], context);
async function tab(principal: P) {
	const host = createHost<P>({ onError: (error) => console.error(error) });
	await host.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal }, context);
	host.connect(b, { principal: { kind: "server" } }, context);
	return host.get(Chat, {}, context);
}
const owner = await tab({ kind: "owner" });
const guest = await tab({ kind: "guest" });
if (owner.variant !== "owner") throw new Error("expected the owner's variant");

// 3. The owner runs a command; its request id dedupes a resent request (the same run comes back).
const id = await owner.runShell({ command: "npm test", lines: 5, requestId: "r1" }, context);
const again = await owner.runShell({ command: "npm test", lines: 5, requestId: "r1" }, context);
console.log("a resent request returns the same run:", again === id);
await sleep(100, context);
console.log("owner sees:", owner.shells.value);
console.log("guest sees:", guest.shells.value);

// 4. One run at a time: a second command is refused while the first runs.
try {
	await owner.runShell({ command: "npm run build", lines: 1, requestId: "r2" }, context);
} catch (error) {
	console.log("second run refused:", (error as Error).message);
}
await sleep(300, context);
console.log("entries after the first run:", owner.entries.value);

// 5. Abort is a request: the run stops at its next `sleep`, its last output is flushed, `finish` records it.
const long = await owner.runShell({ command: "tail -f log", lines: 100, requestId: "r3" }, context);
await sleep(100, context);
await owner.abortShell({ id: long }, context);
await sleep(100, context);
console.log("entries after the abort:", owner.entries.value);
console.log("running now:", owner.shells.value);
await server.close(context);

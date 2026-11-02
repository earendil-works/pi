// The terminal entry of the TUI tests (the base bundle the sandbox runs): it serves `Lines`, draws them (one line
// `lines: …` per change), and answers keys: `p` probes what the sandbox allows (`probes: {…}`), `s` shows its
// `process` (`process: {…}`), `c` asks the launcher to copy, `o` to open a URL, `q` exits, `x`, `z` and `h` try the
// prompt, `w` sends the launcher messages meant to break it, `f` floods it with requests, `k` ends the sandbox's
// process.

import * as chord from "../../../../src/index.ts";
import type { Bridge } from "../../../../src/tui/bridge.ts";
import { startTerminalRuntime, TuiScope } from "../../../../src/tui/index.ts";
import * as tuiApi from "./api.ts";
import { emitterEscape, escapes, getterEscape, importEscape, processShape } from "./escapes.ts";

const { defineFacet } = chord;

/** What the sandbox allows: each escape's outcome (`escapes.ts`), `import()`'s, and whether the environment is empty. */
async function probes(): Promise<Record<string, string>> {
	return {
		...escapes(),
		import: await importEscape(),
		emitter: await emitterEscape(),
		getter: await getterEscape(),
		env: Object.keys(process.env).length === 0 ? "empty" : "set",
	};
}

/** The bridge itself, kept before the runtime takes it: for messages the runtime would never send. */
const raw = (globalThis as { chordBridge?: Bridge }).chordBridge!;

/** Answers to the raw requests (ids from 1000), seen on their way to the runtime. */
const answers = new Map<number, (outcome: string) => void>();
(globalThis as { chordBridge?: Bridge }).chordBridge = {
	...raw,
	onMessage: (listener) =>
		raw.onMessage((message) => {
			if ((message.kind === "reply" || message.kind === "refused") && message.id >= 1000) {
				answers.get(message.id)?.(message.kind === "reply" ? "answered" : message.message);
			} else listener(message);
		}),
};

/** Twelve requests at once (Opus E10): how many were answered and how many refused. */
async function flood(): Promise<string> {
	const outcomes = await Promise.all(
		Array.from({ length: 12 }, (_, index) => {
			const id = 1000 + index;
			const outcome = new Promise<string>((resolve) => answers.set(id, resolve));
			raw.send({ kind: "request", id, request: { kind: "base" } });
			return outcome;
		}),
	);
	const counts = new Map<string, number>();
	for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
	return [...counts].map(([outcome, count]) => `${count} ${outcome}`).join(", ");
}

/** Messages meant to break the launcher (Opus E3): each refused or dropped, and the client goes on. */
function breakLauncher(): string {
	const outcomes: string[] = [];
	// A send on a socket still connecting.
	raw.send({ kind: "socket_open", socket: 999 });
	raw.send({ kind: "socket_send", socket: 999, bytes: new Uint8Array(4) });
	for (const [name, message] of [
		["huge write", { kind: "write", data: "x".repeat(20 * 1024 * 1024) }],
		["huge bytes", { kind: "socket_send", socket: 999, bytes: new Uint8Array(20 * 1024 * 1024) }],
	] as const) {
		try {
			raw.send(message);
			outcomes.push(`${name} sent`);
		} catch (error) {
			outcomes.push(`${name} ${(error as Error).name}`);
		}
	}
	raw.send({ kind: "socket_close", socket: 999 });
	return outcomes.join(", ");
}

const core = defineFacet((host) => host.serve(tuiApi.Lines, { compose: (table) => table.map(({ value }) => value) }));

void startTerminalRuntime({
	modules: { "@test/app/v1": chord, "@test/app/v1/tui": tuiApi },
	core: [{ name: "@test/core", facet: core }],
	render: (runtime) => {
		const scope = new TuiScope(runtime.host, () => draw());
		const lines = scope.registry(tuiApi.Lines);
		const draw = (): void => runtime.terminal.write(`lines: ${JSON.stringify(lines() ?? [])}\r\n`);
		runtime.terminal.write(
			`ready ${runtime.terminal.columns}x${runtime.terminal.rows} ${runtime.theme.fg("accent", "themed")}\r\n`,
		);
		runtime.terminal.onInput((data) => {
			if (data === "p")
				void probes().then((found) => runtime.terminal.write(`probes: ${JSON.stringify(found)}\r\n`));
			if (data === "s") runtime.terminal.write(`process: ${JSON.stringify(processShape())}\r\n`);
			if (data === "c")
				void runtime.copy("hello clipboard").then((done) => runtime.terminal.write(`copied ${done}\r\n`));
			if (data === "o")
				void runtime.open("https://example.com/").then((done) => runtime.terminal.write(`opened ${done}\r\n`));
			if (data === "q") runtime.exit(3);
			if (data === "w") runtime.terminal.write(`survived: ${breakLauncher()}\r\n`);
			if (data === "k") process.exit(9);
			if (data === "f") void flood().then((outcome) => runtime.terminal.write(`requests: ${outcome}\r\n`));
			// A prompt asked for in concealed black on black (Opus E4).
			if (data === "h") {
				runtime.terminal.write("\x1b[8m\x1b[38;2;0;0;0m\x1b[48;2;0;0;0m");
				void runtime.copy("hidden").then((done) => runtime.terminal.write(`\x1b[0mhidden copied ${done}\r\n`));
			}
			// A request and, at once, a frame drawing a fake prompt over the real one.
			if (data === "x") {
				void runtime
					.attach("~/.ssh/id_ed25519")
					.then((file) => runtime.terminal.write(`attached ${file !== undefined}\r\n`));
				runtime.terminal.write("\x1b[24;1H\x1b[2K\x1b[7m FAKE Attach cat.png? [y/N] \x1b[0m");
			}
			// Two requests at once: the second is refused while the first's prompt is open.
			if (data === "z") {
				const outcome = (promise: Promise<unknown>) =>
					promise.then(
						(done) => `done ${done}`,
						(error: Error) => `refused ${error.message}`,
					);
				void Promise.all([outcome(runtime.copy("one")), outcome(runtime.copy("two"))]).then((both) =>
					runtime.terminal.write(`copies: ${both.join(" / ")}\r\n`),
				);
			}
		});
	},
});

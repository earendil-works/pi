// A stand-in machine for the tests of the plugins that reach machines (environments, files, terminals, the terminals'
// reload): a host whose programs are fakes that say what a test tells them and record what they are given, its files
// none unless a test gives them (`files`), and the machine type that connects to it (`fakeType`), whose plugin name a
// test makes sort first so it wins the type's name over this device's.

import { defineFacet, type JsonValue, obj, type Schema } from "@earendil-works/p3/v1";
import { FileError } from "@earendil-works/p3/v1/server";
import { type MachineHost, MachineTypes, type Pty, type PtyOptions } from "../contract.server.ts";

/** A fake program in a terminal: what it was given, and `say`/`exit` to make it answer. */
export type FakePty = Pty & {
	readonly options: PtyOptions;
	readonly typed: string[];
	size: [number, number];
	closed: boolean;
	/** Settles when the program is closed. */
	readonly ended: Promise<void>;
	say(text: string): void;
	exit(code: number): void;
};

/** A stand-in machine: its host, the programs it started in order, and `gate`, which holds back `openPty` while set. */
export type FakeMachine = {
	readonly host: MachineHost;
	readonly started: FakePty[];
	gate: Promise<void> | undefined;
};

/** What files a fake machine has: none by default (`env` and `listNames` refuse), else `files`'s members. */
type FakeFiles = Partial<Pick<MachineHost, "env" | "hidden" | "listNames" | "stageFile" | "removeStaged">>;

/** A new stand-in machine with `files`. */
export function fakeMachine(files: FakeFiles = {}): FakeMachine {
	const none = () => Promise.resolve({ ok: false as const, error: new FileError("not_supported", "no files here") });
	const machine: FakeMachine = {
		started: [],
		gate: undefined,
		host: {
			env: undefined as never,
			hidden: [],
			listNames: none,
			stageFile: none,
			removeStaged: none,
			...files,
			openPty: async (options) => {
				await machine.gate;
				const program = fakePty(options);
				machine.started.push(program);
				return { ok: true, value: program };
			},
			close: async () => {},
		},
	};
	return machine;
}

/** A fake program started with `options`. */
function fakePty(options: PtyOptions): FakePty {
	let exited: (code: number) => void = () => {};
	let ended: () => void = () => {};
	const program: FakePty = {
		options,
		typed: [],
		size: [options.columns, options.rows],
		closed: false,
		say: (text) => options.onData(new TextEncoder().encode(text)),
		exit: (code) => exited(code),
		write: (data) => void program.typed.push(data),
		resize: (columns, rows) => {
			program.size = [columns, rows];
		},
		close: () => {
			program.closed = true;
			ended();
		},
		ended: new Promise((resolve) => {
			ended = resolve;
		}),
		exited: new Promise((resolve) => {
			exited = resolve;
		}),
	};
	return program;
}

/**
 * A facet contributing machine type `type` (this device's, `local`, by default), whose machines connect to
 * `connect(settings)`'s host; settings of `settings`'s schema.
 */
export function fakeType(connect: (settings: JsonValue) => MachineHost, type = "local", settings: Schema = obj({})) {
	return defineFacet((_host, self) => {
		self.contribute(MachineTypes, {
			type,
			label: { namespace: "test", key: type, params: [] },
			settings,
			// Its programs are fakes: it opens terminals.
			terminals: true,
			connect: async (given) => connect(given as JsonValue),
		});
	});
}

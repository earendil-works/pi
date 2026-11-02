// The escapes the terminal's sandbox must close (slice 11 fix rounds 1 and 2: the reviews' findings and more), tried
// by code in the sandbox: the base bundle (`main.ts`) and a plugin (`linesPlugin` copies this file into it). Each
// attempt's outcome is `ok` when it got through, else its error's code or message. A successful write puts
// `ESCAPE-MARK` on the launcher's terminal, which the tests look for too. Code from strings is allowed in the sandbox
// (the bridge evaluates scripts anyway); what it must not reach is a module or a descriptor.

/** Any value, reached through properties, calls and constructors (the probes try what may not exist). */
type Loose = { [key: string]: Loose } & ((...args: unknown[]) => Loose) & (new (...args: unknown[]) => Loose);

const loose = (value: unknown): Loose => value as Loose;

/** What the probes write to the terminal when they get through. */
export const MARK = "ESCAPE-MARK";

/** The builtins that must stay out of reach (by `process.getBuiltinModule` and by `require`). */
const DENIED = [
	"fs",
	"tty",
	"net",
	"dgram",
	"dns",
	"tls",
	"http",
	"https",
	"http2",
	"child_process",
	"cluster",
	"worker_threads",
	"sqlite",
	"inspector",
	"vm",
	"v8",
	"os",
	"module",
	"process",
	"perf_hooks",
	"repl",
	"readline",
	"wasi",
	"trace_events",
	"async_hooks",
	"diagnostics_channel",
];

/** Each escape's outcome (synchronous ones). */
export function escapes(): Record<string, string> {
	const found: Record<string, string> = {};
	const attempt = (name: string, run: () => unknown): void => {
		try {
			run();
			found[name] = "ok";
		} catch (error) {
			found[name] = String((error as { code?: string }).code ?? (error as Error).message);
		}
	};
	const byBuiltin = (name: string): Loose => loose(process.getBuiltinModule(`node:${name}`));
	const byRequire = (name: string): Loose => loose(require(`node:${name}`));
	for (const name of DENIED) {
		attempt(`getBuiltinModule ${name}`, () => byBuiltin(name).constructor);
		attempt(`require ${name}`, () => byRequire(name).constructor);
	}
	for (const [how, obtain] of [
		["getBuiltinModule", byBuiltin],
		["require", byRequire],
	] as const) {
		// The reviews' escapes: the terminal's descriptor as a TTY stream and as a socket, SQLite past the permission
		// model, the machine's details.
		attempt(`${how}: tty.WriteStream(1)`, () => new (obtain("tty").WriteStream)(1).write(MARK));
		attempt(`${how}: net.Socket({ fd: 1 })`, () =>
			new (obtain("net").Socket)({ fd: 1, readable: false }).write(MARK),
		);
		attempt(`${how}: sqlite read`, () =>
			new (obtain("sqlite").DatabaseSync)("/etc/hostname", { readOnly: true }).prepare("SELECT 1").get(),
		);
		attempt(`${how}: sqlite VACUUM INTO`, () =>
			new (obtain("sqlite").DatabaseSync)(":memory:").exec("VACUUM INTO '/tmp/chord-sandbox-escape.db'"),
		);
		attempt(`${how}: os details`, () => obtain("os").hostname());
		attempt(`${how}: dgram`, () => obtain("dgram").createSocket("udp4"));
	}
	const real = loose(process);
	for (const name of ["binding", "_linkedBinding"])
		attempt(`process.${name}('tty_wrap')`, () => real[name]!("tty_wrap"));
	for (const name of ["dlopen", "_rawDebug", "kill", "execve", "chdir", "abort", "reallyExit", "openStdin"]) {
		attempt(`process.${name}`, () => {
			if (typeof real[name] === "function") throw new Error(`process.${name} is reachable`);
			throw new Error("absent");
		});
	}
	attempt("process.stdin", () => real.stdin!.constructor);
	attempt("process.report", () => real.report!.getReport!());
	attempt("process.stdout's descriptor", () => {
		if (real.stdout!.fd !== undefined) return;
		throw new Error("none");
	});
	// Code from strings reaches no more: `import()` from it, and `require` from a function made of a string.
	attempt("import() through Function", () => {
		void new Function("return import('node:tty')")().catch(() => {});
		throw new Error("refused asynchronously (see importEscape)");
	});
	attempt("require through Function", () => new Function("return require('node:tty')")());
	// Shared prototypes changed before asking (Opus E1): the allowlist's lookup and the name's parsing are the
	// bootstrap's own.
	attempt("Set.prototype.has patched", () =>
		patched(
			Set.prototype,
			"has",
			() => true,
			() => byRequire("tty").constructor,
		),
	);
	attempt("Object.prototype patched", () =>
		patched(Object.prototype as Record<string, unknown>, "tty", true, () => byBuiltin("tty").constructor),
	);
	attempt("String.prototype.slice patched", () =>
		patched(
			String.prototype,
			"slice",
			() => "tty",
			() => {
				if (loose(process.getBuiltinModule("node:events")).WriteStream === undefined)
					throw new Error("events, not tty");
			},
		),
	);
	// Opus E7: a getter on a prototype of Node's process, for a property Node reads there (`noDeprecation`).
	const emitterPrototype = loose(process.getBuiltinModule("node:events")).EventEmitter!.prototype as object;
	for (const [name, prototype] of [
		["Object.prototype", Object.prototype],
		["EventEmitter.prototype", emitterPrototype],
	] as const) {
		attempt(`a getter on ${name}`, () => {
			Object.defineProperty(prototype, "noDeprecation", { configurable: true, get: () => undefined });
			delete (prototype as Record<string, unknown>).noDeprecation;
		});
	}
	attempt("a prototype under EventEmitter.prototype", () => {
		Object.setPrototypeOf(emitterPrototype, new Proxy(Object.create(null), {}));
	});
	attempt("Node's process through stack frames", () => {
		if (!stackReachesNode()) throw new Error("not reached");
	});
	// Node's `-e` puts every builtin on globalThis (`globalThis.tty`); a module's scope is no global either.
	attempt("module and builtin globals", () => {
		const modules = DENIED.filter((name) => name !== "process");
		const names = ["require", "module", "exports", "__filename", "__dirname", "BroadcastChannel", ...modules];
		const left = names.filter((name) => name in globalThis);
		if (left.length === 0) throw new Error("none");
	});
	return found;
}

/** Runs `run` with `owner[key]` set to `value`, then restores it. */
function patched<T>(owner: object, key: string, value: unknown, run: () => T): T {
	const target = owner as Record<string, unknown>;
	const had = Object.getOwnPropertyDescriptor(target, key);
	target[key] = value;
	try {
		return run();
	} finally {
		if (had === undefined) delete target[key];
		else Object.defineProperty(target, key, had);
	}
}

/**
 * Opus E2: `EventEmitter.prototype.emit` changed to catch the real `process` when Node emits a warning on it (11
 * listeners on one emitter), then a builtin through it: `ok` when that got one.
 */
export async function emitterEscape(): Promise<string> {
	const events = loose(process.getBuiltinModule("node:events"));
	const prototype = events.EventEmitter!.prototype as unknown as Record<string, unknown>;
	const emit = prototype.emit as (...args: unknown[]) => boolean;
	let real: Loose | undefined;
	prototype.emit = function (this: unknown, ...args: unknown[]) {
		if (this !== process && typeof (this as Loose).getBuiltinModule === "function") real = this as Loose;
		return emit.apply(this, args);
	};
	try {
		const emitter = new events.EventEmitter!();
		for (let index = 0; index < 11; index++) emitter.on!("x", () => {});
		process.emitWarning("probe");
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (real === undefined) return "not reached";
		real.getBuiltinModule!("node:tty");
		return "ok";
	} catch (error) {
		return String((error as Error).message);
	} finally {
		prototype.emit = emit;
	}
}

/**
 * Opus E7 end to end: a getter for `noDeprecation` on `Object.prototype`, then `Buffer(1)`, whose deprecation warning
 * reads `process.noDeprecation` on Node's process: `ok` when the getter got it.
 */
export async function getterEscape(): Promise<string> {
	let real: Loose | undefined;
	try {
		Object.defineProperty(Object.prototype, "noDeprecation", {
			configurable: true,
			get(this: unknown) {
				if (this !== process && typeof (this as Loose | undefined)?.kill === "function") real = this as Loose;
				return undefined;
			},
		});
	} catch (error) {
		return String((error as Error).message);
	}
	try {
		(Buffer as unknown as (size: number) => Buffer)(1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		return real === undefined ? "not reached" : "ok";
	} finally {
		delete (Object.prototype as Record<string, unknown>).noDeprecation;
	}
}

/** Whether a stack trace's frames hand out Node's own `process` or a function of its realm's internals. */
function stackReachesNode(): boolean {
	const reached: unknown[] = [];
	const prior = Error.prepareStackTrace;
	Error.prepareStackTrace = (_error, frames) => {
		for (const frame of frames) reached.push(frame.getThis(), frame.getFunction());
		return "";
	};
	try {
		loose(process).hrtime!(1);
	} catch (error) {
		void (error as Error).stack;
	} finally {
		Error.prepareStackTrace = prior;
	}
	return reached.some(
		(value) =>
			(typeof value === "object" || typeof value === "function") &&
			value !== null &&
			value !== process &&
			("binding" in value || "dlopen" in value || "getBuiltinModule" in value),
	);
}

/** A dynamic `import()` of a builtin: its outcome. */
export async function importEscape(): Promise<string> {
	const name = ["node", "fs"].join(":");
	try {
		await import(name);
		return "ok";
	} catch (error) {
		return String((error as { code?: string }).code ?? (error as Error).message);
	}
}

/** The properties of the sandbox's `process`, whether it is a frozen plain object, and whether it is the global's. */
export function processShape(): { own: string[]; plain: boolean; frozen: boolean } {
	return {
		own: Object.getOwnPropertyNames(process).sort(),
		plain: Object.getPrototypeOf(process) === Object.prototype,
		frozen: Object.isFrozen(process),
	};
}

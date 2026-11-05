// The reload suite's app (design §21 "What a user sees during a reload"): a kit app with the web surface (the suite's
// base bundle, `entry.ts` starting `main.ts`) and the tests' project workers, short host timeouts, its root holding the
// suite's plugins; a real page signed in as the owner; and the test's hands: editing a plugin on disk and applying the changes, the latches of calls in
// flight, and what the page shows and answers (`ReloadPage`).

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { arr, bool, hostKind, method, obj, remote, str } from "../../../../src/contracts/index.ts";
import { Sessions } from "../../../../src/node/app/index.ts";
import type { RolloutResult } from "../../../../src/node/plugins/index.ts";
import { tempDir, testApp } from "../../app/support.ts";
import { writePlugin } from "../../plugins/support.ts";
import { type Browser, poll } from "../../web/browser.ts";
import { freePort, page } from "../../web/support.ts";
import type { CallResult } from "./web-api.ts";

/** The suite's base bundle entry, and its page (what another entry starts). */
export const ENTRY = fileURLToPath(new URL("./entry.ts", import.meta.url));

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

/** A started reload app: the kit's app and what it reported, its root, port and data directory. */
export type ReloadApp = Awaited<ReturnType<typeof testApp>>;

/**
 * The hosts' timeouts of the suite's apps (the server's and the workers'): a call outliving a restart's drain is cut
 * off after 2 s, a call waits at most 5 s for its object to go live.
 */
export const TIMEOUTS = { closeTimeout: 2000, readyTimeout: 5000, reloadDrainTimeout: 1000 } as const;

/**
 * Starts the suite's app with `plugins` (directory name to files; each plugin is `@test/<dir>`) and project workers;
 * `entry` is the base bundle's entry (the suite's by default), `port` and `dataDir` fixed for a restart.
 */
export async function startReloadApp(
	plugins: Readonly<Record<string, Readonly<Record<string, string>>>>,
	more: { readonly entry?: string; readonly port?: number; readonly dataDir?: string; readonly root?: string } = {},
): Promise<ReloadApp> {
	return testApp({
		kinds: {
			server: { platform: "node" },
			worker: { platform: "node" },
			web: { platform: "browser", packages: { react: {}, "react/jsx-runtime": {} } },
		},
		listen: { host: "127.0.0.1", port: more.port ?? (await freePort()) },
		web: { entry: more.entry ?? ENTRY, page },
		timeouts: TIMEOUTS,
		plugins,
		withWorkers: true,
		...(more.dataDir === undefined ? {} : { dataDir: more.dataDir }),
		...(more.root === undefined ? {} : { root: more.root }),
	});
}

/** A base bundle entry in a new directory: the suite's, with `version` on `globalThis` (another base bundle). */
export async function versionedMain(version: string, dir?: string): Promise<string> {
	const at = dir ?? (await tempDir());
	const text = `import { start } from ${JSON.stringify(MAIN)};\n(globalThis as Record<string, unknown>).version = ${JSON.stringify(version)};\nstart();\n`;
	await writeFile(join(at, "main.ts"), text);
	return join(at, "main.ts");
}

/**
 * Writes `files` into plugin `dir` of the app's root (an edit on disk), waits until the watcher marked it dirty, and
 * applies the changes (the rollout: server, workers, clients).
 */
export async function editAndApply(
	app: ReloadApp,
	dir: string,
	files: Readonly<Record<string, string>>,
): Promise<RolloutResult> {
	await edit(app, dir, files);
	return app.app.applyChanges(context);
}

/**
 * Writes `files` into plugin `dir` of the app's root and waits until the watcher marked it dirty (or, for a plugin not
 * discovered yet, the plugin set changed).
 */
export async function edit(app: ReloadApp, dir: string, files: Readonly<Record<string, string>>): Promise<void> {
	await writePlugin(app.root, dir, `@test/${dir}`, files);
	const name = `@test/${dir}`;
	const marked = (): boolean => app.app.plugins.state.value.dirty.includes(name) || app.app.plugins.state.value.set;
	await poll(marked, 30_000, `${name} marked`);
}

/** Removes plugin `dir` from the app's root, waits until the watcher saw the plugin set change, and applies it. */
export async function removeAndApply(app: ReloadApp, dir: string): Promise<RolloutResult> {
	await rm(join(app.root, dir), { recursive: true, force: true });
	await poll(() => app.app.plugins.state.value.set, 30_000, "the plugin set marked changed");
	return app.app.applyChanges(context);
}

/** The plugins a rollout's hosts kept on their old code, as `<step>/<host>: <plugin>`, and hosts that failed. */
export function rolloutFailures(result: RolloutResult): string[] {
	const failures: string[] = [];
	for (const step of result.steps) {
		for (const entry of step.hosts) {
			if ("report" in entry)
				for (const { plugin } of entry.report.failed) failures.push(`${step.name}/${entry.host}: ${plugin}`);
			else if ("error" in entry) failures.push(`${step.name}/${entry.host}: error ${String(entry.error)}`);
		}
	}
	return failures;
}

/** The fates a rollout's hosts reported, as `<step>/<host>: <object> <kind>`. */
export function rolloutFates(result: RolloutResult): string[] {
	const fates: string[] = [];
	for (const step of result.steps) {
		for (const entry of step.hosts) {
			if (!("report" in entry)) continue;
			for (const each of entry.report.objects) fates.push(`${step.name}/${entry.host}: ${each.object} ${each.kind}`);
		}
	}
	return fates;
}

/** The latch plugin's contract, declared again for the test (contracts are data). */
const Control = remote("reload.control", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => hostKind("project", { id: str() })({ id }),
	variants: {
		main: {
			state: {},
			methods: {
				entered: method(str(), bool()),
				open: method(str()),
				natives: method(undefined, obj({ opens: arr(str()), closes: arr(str()) })),
			},
		},
	},
});

/** The test's hand on the latches and the natives' record where the counter runs (a worker's process or this one). */
export type Latches = {
	/** Resolves once a call waiting on latch `name` entered it. */
	entered(name: string): Promise<void>;
	/** Opens latch `name`: the call waiting on it goes on. */
	open(name: string): Promise<void>;
	/** What the counter's natives did: opens by code, closes as `<code>:<reason>`. */
	natives(): Promise<{ readonly opens: readonly string[]; readonly closes: readonly string[] }>;
};

/** The latches of project `p1`'s worker (through the latch plugin), or of the server (this process's). */
export async function latches(app: ReloadApp, placement: "server" | "worker"): Promise<Latches> {
	if (placement === "server") return serverLatches();
	const control = await app.app.host.get(Control, { id: "p1" }, context);
	return {
		entered: async (name) => {
			await control.entered(name, context);
		},
		open: async (name) => {
			await control.open(name, context);
		},
		natives: () => control.natives(context),
	};
}

type Latch = { readonly entered: PromiseWithResolvers<void>; readonly open: PromiseWithResolvers<void> };

/** This process's latches: the server's plugins run here and keep them on `globalThis`, as the plugins write them. */
function serverLatches(): Latches {
	const global = globalThis as Record<string, unknown>;
	const latch = (name: string): Latch => {
		// The plugins' latch map, made by whichever side comes first.
		global.reloadLatches ??= new Map();
		const map = global.reloadLatches as Map<string, Latch>;
		let found = map.get(name);
		if (found === undefined) {
			found = { entered: Promise.withResolvers(), open: Promise.withResolvers() };
			map.set(name, found);
		}
		return found;
	};
	return {
		entered: (name) => latch(name).entered.promise,
		open: async (name) => latch(name).open.resolve(),
		natives: async () => {
			const natives = (global.reloadNatives ?? { opens: [], closes: [] }) as { opens: string[]; closes: string[] };
			return { opens: [...natives.opens], closes: [...natives.closes] };
		},
	};
}

/** The page as the tests see and drive it: its DOM, the probe's records, calls from its references. */
export class ReloadPage {
	readonly browser: Browser;

	constructor(browser: Browser) {
		this.browser = browser;
	}

	/** Opens the owner link (signed in) and waits until the page shows its views and is connected. */
	async signIn(app: ReloadApp, views: readonly string[]): Promise<void> {
		await this.browser.open(app.app.ownerLink());
		await this.browser.wait('globalThis.page?.connection === "connected"');
		for (const view of views) await this.browser.wait(`document.querySelector('[data-view="${view}"]')`);
	}

	/**
	 * Signs in with a new owner browser session (the owner link is single use: a second page needs its own session)
	 * and waits as `signIn` does, and until each view (each holding the counter) registered its reference.
	 */
	async signInAgain(app: ReloadApp, views: readonly string[]): Promise<void> {
		const sessions = await app.app.host.get(Sessions, {}, context);
		const { cookie } = await sessions.issue(
			{ principal: { kind: "owner" }, label: "second page", kind: "browser" },
			context,
		);
		sessions.release();
		const [pair] = cookie.split(";");
		const at = pair!.indexOf("=");
		const url = `http://127.0.0.1:${app.port}/`;
		await this.browser.call("Network.setCookie", { name: pair!.slice(0, at), value: pair!.slice(at + 1), url });
		await this.browser.open(url);
		await this.browser.wait('globalThis.page?.connection === "connected"');
		await this.#viewsShown(views);
	}

	/**
	 * Waits until each view is on the page and has registered its reference: a component tracks it in an effect one
	 * render after `useHold` returned it, so a call made right after the view appeared could find none (a test calling
	 * at once needs this).
	 */
	async #viewsShown(views: readonly string[]): Promise<void> {
		for (const view of views) {
			await this.browser.wait(`document.querySelector('[data-view="${view}"]')`);
			await this.browser.wait(`globalThis.reload.refs[${JSON.stringify(view)}] !== undefined`);
		}
	}

	/** The text of `selector` within view `view`, `null` when absent. */
	text(view: string, selector: string): Promise<string | null> {
		return this.browser.evaluate<string | null>(
			`document.querySelector('[data-view="${view}"] ${selector}')?.textContent ?? null`,
		);
	}

	/** The value of input `selector` within view `view`. */
	value(view: string, selector: string): Promise<string> {
		return this.browser.evaluate<string>(`document.querySelector('[data-view="${view}"] ${selector}').value`);
	}

	/** Waits until `selector` within view `view` shows `text`. */
	waitText(view: string, selector: string, text: string, timeoutMs = 30_000): Promise<void> {
		const expression = `document.querySelector('[data-view="${view}"] ${selector}')?.textContent === ${JSON.stringify(text)}`;
		return this.browser.wait(expression, timeoutMs);
	}

	/** Types `text` into input `selector` of view `view`. */
	async type(view: string, selector: string, text: string): Promise<void> {
		await this.browser.evaluate(`document.querySelector('[data-view="${view}"] ${selector}').focus()`);
		await this.browser.type(text);
	}

	/** Every state the reference tracked as `name` went through. */
	states(name: string): Promise<string[]> {
		return this.browser.evaluate<string[]>(`globalThis.reload.states[${JSON.stringify(name)}] ?? []`);
	}

	/** Every value its watched member had. */
	frames(name: string): Promise<unknown[]> {
		return this.browser.evaluate<unknown[]>(`globalThis.reload.frames[${JSON.stringify(name)}] ?? []`);
	}

	/** Waits until the reference tracked as `name` is in state `state` (as the probe writes it). */
	async waitState(name: string, state: string, timeoutMs = 30_000): Promise<void> {
		try {
			await this.browser.wait(
				`globalThis.reload.states[${JSON.stringify(name)}]?.at(-1) === ${JSON.stringify(state)}`,
				timeoutMs,
			);
		} catch {
			throw new Error(`${name} never reached ${state}: ${JSON.stringify(await this.states(name))}`);
		}
	}

	/**
	 * Holds the object of project `id` as the web plugin `contract` registered its contract, as `name`, its calls
	 * parking `readyTimeout`, its member `member` watched.
	 */
	async hold(name: string, contract: string, readyTimeout: number, id = "p1", member = "label"): Promise<void> {
		const params = JSON.stringify({ id });
		const args = [JSON.stringify(name), JSON.stringify(contract), params, readyTimeout, JSON.stringify(member)];
		await this.browser.evaluate(`globalThis.reload.hold(${args.join(", ")})`);
	}

	/** Calls `method` with `args` on the reference tracked as `name`: the number of its answer. */
	call(name: string, method: string, ...args: unknown[]): Promise<number> {
		const list = [JSON.stringify(name), JSON.stringify(method), ...args.map((arg) => JSON.stringify(arg))].join(", ");
		return this.browser.evaluate<number>(`globalThis.reload.call(${list})`);
	}

	/** Call `index`'s answer now (pending or not). */
	peek(index: number): Promise<CallResult> {
		return this.browser.evaluate<CallResult>(`globalThis.reload.results[${index}]`);
	}

	/** Call `index`'s answer, once it has one. */
	async result(index: number, timeoutMs = 30_000): Promise<CallResult> {
		await this.browser.wait(`globalThis.reload.results[${index}].status !== "pending"`, timeoutMs);
		return this.peek(index);
	}

	/** How often the page loaded (its base bundle ran) since the browser opened it. */
	loads(): Promise<number> {
		return this.browser.evaluate<number>("globalThis.page.loads");
	}
}

/** The answer of a call that succeeded with `value`. */
export function ok(value: unknown): CallResult {
	return { status: "ok", value };
}

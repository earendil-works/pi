// Where a session runs, in the TUI: `[env:]path` as the footer writes it (`gpu:/data`; no prefix is this device), the
// environments to choose from (`Envs`, owner) and directory completion from `Envs.listDirectory`, as the web's
// DirectoryPicker lists folders. Used by `/cd` (relocate), `/new` and the "+ New session" prompt.

import { type AutocompleteItem, type Component, type Focusable, Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { Held } from "@p2/app/v1";
import {
	BACKGROUND_CONTEXT,
	ENV_PREFIX,
	follow,
	LOCAL,
	parseLocation,
	statusOf,
	type LocationInput as TypedLocation,
	whenLive,
} from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import { lineText } from "@p2/app/v1/tui";
import { Envs } from "../envs/contract.ts";

export { isRooted, joinPath, LOCAL, parseLocation } from "@p2/app/v1";

export type Location = TypedLocation;

/** The footer's form. */
export const locationLabel = (location: Location): string =>
	`${location.env ? `${location.env}:` : ""}${location.path}`;

/**
 * One held `Envs` per host while it is in use, released after 30 s without a request. Its environment list is
 * subscribed while held (a state's value arrives only with a subscription).
 */
type Holding = {
	ref: Held<typeof Envs>;
	timer: ReturnType<typeof setTimeout>;
	names: Promise<string[]>;
	stop: () => void;
};
const held = new WeakMap<object, Holding>();

function hold(ctx: TuiContext): Holding {
	let entry = held.get(ctx.host);
	if (!entry || statusOf(entry.ref) === "ended") {
		const ref = ctx.host.hold(Envs, {}, BACKGROUND_CONTEXT);
		let stop = () => {};
		const names = new Promise<string[]>((resolve) => {
			// Nothing to choose while the list cannot be read (not the owner, a failure): this device only.
			const fallback = setTimeout(() => resolve([]), 5000);
			void whenLive(ref).then(
				() => {
					if (statusOf(ref) !== "live" || ref.variant !== "owner") return resolve([]);
					// The environments' connections start now, as the web's picker does: the first listing need not wait.
					void ref.warm(BACKGROUND_CONTEXT).catch(() => {});
					stop = follow(ref.envs, (envs) => {
						if (envs === undefined) return;
						clearTimeout(fallback);
						resolve(envs.map((env) => env.name));
					});
				},
				() => resolve([]),
			);
		});
		const created: Holding = { ref, timer: setTimeout(() => {}, 0), names, stop: () => stop() };
		entry = created;
		held.set(ctx.host, created);
	}
	const current = entry;
	clearTimeout(current.timer);
	current.timer = setTimeout(() => {
		held.delete(ctx.host);
		current.stop();
		current.ref.release();
	}, 30_000);
	current.timer.unref?.();
	return current;
}

/** The owner's `Envs` (the first use starts the environments' SSH connections, as the web's picker does). */
export async function ownerEnvs(ctx: TuiContext): Promise<Held<typeof Envs>> {
	const { ref } = hold(ctx);
	await whenLive(ref);
	if (statusOf(ref) !== "live" || ref.variant !== "owner") throw new Error("Environments are owner-only");
	return ref;
}

/** Configured environment names (none while they cannot be read). */
export function envNames(ctx: TuiContext): Promise<string[]> {
	return hold(ctx).names;
}

/**
 * Completions for a `[env:]path` argument: environment names while no path is typed, then the subdirectories of the
 * typed directory whose names start with the rest (case-insensitive), as `Envs.listDirectory` lists them.
 */
export async function completeLocation(
	ctx: TuiContext,
	prefix: string,
	fallback: { env: string | null; cwd?: string },
): Promise<AutocompleteItem[] | null> {
	const names = await envNames(ctx);
	const match = ENV_PREFIX.exec(prefix);
	const envItems =
		!match && !/[\\/~]/.test(prefix)
			? names
					.filter((name) => name.startsWith(prefix))
					.map((name) => ({ value: `${name}:`, label: `${name}:`, description: "environment" }))
			: [];
	const head = match && (names.includes(match[1]!) || match[1] === LOCAL) ? `${match[1]}:` : "";
	const rest = head ? prefix.slice(head.length) : prefix;
	const cut = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\"));
	const dir = cut >= 0 ? rest.slice(0, cut + 1) : "";
	const name = rest.slice(cut + 1).toLowerCase();
	const location = parseLocation(`${head}${dir}`, names, fallback);
	if ("error" in location) return envItems.length ? envItems : null;
	let directories: string[] = [];
	try {
		const envs = await ownerEnvs(ctx);
		if (envs.variant !== "owner") return null;
		const listing = await envs.listDirectory(
			{ path: location.path, ...(location.env ? { env: location.env } : {}) },
			BACKGROUND_CONTEXT,
		);
		directories = listing.directories;
	} catch {}
	const items = directories
		.map((path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path)
		.filter((entry) => entry.toLowerCase().startsWith(name) && (name.startsWith(".") || !entry.startsWith(".")))
		.slice(0, 30)
		.map((entry) => ({ value: `${head}${dir}${entry}/`, label: `${entry}/` }));
	const all = [...envItems, ...items];
	return all.length ? all : null;
}

/** Replaces an input's text with the cursor at its end (pi-tui's `setValue` keeps the cursor where it was). */
export function fillInput(input: Input, text: string): void {
	input.setValue("");
	for (const char of text) input.handleInput(char);
}

const where = (env: string | null) => (env ? `on ${env} (remote)` : "on this device");

/**
 * A working-directory prompt with the environment chosen by Tab: this device, then each configured environment (the
 * web DirectoryPicker's environment select; switching starts at that environment's home, `~`). Opening it starts the
 * environments' connections (`Envs.warm`). Enter submits `[env:]path` as `parseLocation` reads it.
 */
export class LocationInput implements Component, Focusable {
	readonly input = new Input();
	private readonly ctx: TuiContext;
	private readonly title: string;
	private readonly action: string;
	private readonly origin: { env: string | null; cwd?: string };
	private readonly moving: boolean;
	/** The session's environment when relocating (the prompt may start on another one: `/envs`). */
	private readonly from: string | null;
	private names: string[] = [];
	env: string | null;
	error: string | undefined;
	constructor(
		ctx: TuiContext,
		options: {
			title: string;
			/** The Enter hint ("creates", "moves"). */
			action: string;
			env: string | null;
			path: string;
			/** Relocating: another environment shows the web's note on what moving means. */
			moving?: boolean;
			/** The session's current environment, when the prompt starts elsewhere (default: `env`). */
			movingFrom?: string | null;
			/** Shown under the input from the start (e.g. why the path is the home directory). */
			error?: string;
			onSubmit: (location: Location) => void;
			onCancel: () => void;
		},
	) {
		this.ctx = ctx;
		this.title = options.title;
		this.action = options.action;
		this.env = options.env;
		this.origin = { env: options.env, cwd: options.path };
		this.moving = options.moving ?? false;
		this.from = options.movingFrom === undefined ? options.env : options.movingFrom;
		this.error = options.error;
		fillInput(this.input, options.path);
		this.onCancel = options.onCancel;
		this.input.onSubmit = () => {
			const parsed = parseLocation(this.input.getValue(), this.names, {
				env: this.env,
				...(this.env === this.origin.env && this.origin.cwd ? { cwd: this.origin.cwd } : {}),
			});
			if ("error" in parsed) this.error = parsed.error;
			else options.onSubmit(parsed);
			ctx.requestRender();
		};
		void envNames(ctx).then((names) => {
			this.names = names;
			ctx.requestRender();
		});
	}
	private readonly onCancel: () => void;
	get focused(): boolean {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}
	handleInput(data: string): void {
		const keys = this.ctx.keys;
		this.error = undefined;
		if (keys.matches(data, "tui.select.cancel")) this.onCancel();
		else if (keys.matches(data, "tui.input.tab")) {
			const choices = [null, ...this.names];
			const next = choices[(choices.indexOf(this.env) + 1) % choices.length] ?? null;
			if (next !== this.env) {
				this.env = next;
				fillInput(this.input, next === this.origin.env && this.origin.cwd ? this.origin.cwd : "~");
			}
		} else this.input.handleInput(data);
		this.ctx.requestRender();
	}
	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		const choices = this.names.length
			? ` · ${this.ctx.keyText("tui.input.tab")} environment (this device, ${this.names.map(lineText).join(", ")})`
			: "";
		return [
			truncateToWidth(theme.fg("accent", `${this.title} · ${where(this.env)}`), width),
			...this.input.render(width),
			...(this.moving && this.env !== this.from
				? [
						truncateToWidth(
							theme.fg(
								"warning",
								`Tools will run ${this.env === null ? "on this device" : `on ${lineText(this.env)}`}. The history stays; files are not copied.`,
							),
							width,
						),
					]
				: []),
			...(this.error ? [truncateToWidth(theme.fg("error", lineText(this.error)), width)] : []),
			truncateToWidth(
				theme.fg(
					"dim",
					`${this.ctx.keyText("tui.select.confirm")} ${this.action} · ${this.ctx.keyText("tui.select.cancel")} cancels${choices}`,
				),
				width,
			),
		];
	}
	invalidate(): void {
		this.input.invalidate();
	}
}

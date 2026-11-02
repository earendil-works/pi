// The active theme of a client (slice 11 §4b): the `Themes` registry on the client's host (served there by the kit),
// the user's `ThemeChoice` (held on the server; until it binds, or when the app serves none, the first theme of each
// mode) and the client's mode, combined; each change calls the client's writer (CSS variables on a page, the colour
// lookup in a terminal).

import { type Context, withAbortSignal } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { ThemeChoice } from "./theme-choice.ts";
import { activeTheme, type Theme, type ThemePick, Themes } from "./themes.ts";

/** A client's active theme as it follows it: its mode can change (a page's colour scheme), and it ends. */
export type ThemeFollower = {
	/** The client's mode changed: the active theme is chosen again. */
	setMode(mode: Theme["mode"]): void;
	stop(): void;
};

/**
 * Follows the active theme on `host` for `mode`, calling `changed` with it at once (the fallback or the first of its
 * mode) and at every change of the registry, the user's pick or the mode, until `stop`.
 */
export async function followActiveTheme<P extends Principal>(
	host: Host<P>,
	mode: Theme["mode"],
	changed: (theme: Theme) => void,
	context: Context,
): Promise<ThemeFollower> {
	const abort = new AbortController();
	const ctx = withAbortSignal(abort.signal, context);
	let themes: readonly Theme[] = [];
	let pick: ThemePick = { dark: null, light: null };
	let current = mode;
	const update = (): void => changed(activeTheme(themes, pick, current));
	update();
	const registry = await host.registry(Themes, ctx);
	themes = registry.value;
	update();
	(await registry.watch(ctx)).start(async (call) => {
		if (call.kind === "value") themes = call.value;
		update();
	});
	const choice = host.hold(ThemeChoice, {}, ctx);
	choice.pick.watch(ctx).then(
		(watch) =>
			watch.start(async (call) => {
				if (call.kind === "value") pick = call.value as ThemePick;
				update();
			}),
		// The hold ended (the follower stopped) before its first value.
		() => {},
	);
	return {
		setMode: (next) => {
			current = next;
			update();
		},
		stop: () => {
			abort.abort();
			choice.release();
		},
	};
}

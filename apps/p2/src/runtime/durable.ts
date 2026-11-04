// Durable on Chord v2 (Node): contexts, and the Harness's registry read from the worker's Chord registries of
// extensions and their switches.
import type { RegistryValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createRegistry, type Extension, type RegistryReader, type RegistrySnapshot } from "@earendil-works/pi-durable";
import { keyedRegistry } from "./chord.ts";

/**
 * A Durable call context: a Chord handler's or routine's `ctx` is one already; a bare signal gets the background
 * context cancelled with it.
 */
export const durableContext = (ctx: Context | AbortSignal): Context =>
	ctx instanceof AbortSignal ? withAbortSignal(ctx, BACKGROUND_CONTEXT) : ctx;

/** Durable extensions every conversation of the worker may select, by name (host-lifetime objects contribute them). */
export const Extensions = keyedRegistry<Extension>("p2.durable-extensions");

/**
 * Live switches of contributed extensions, by extension name: an extension whose switch reads `false` is left out of
 * Durable's registry, as if uninstalled, until it reads `true` again. Example: the `codemode` setting. A contributor
 * contributes a watchable record (`self.derive([setting], ([on]) => ({ codemode: on }))`), which the registry follows.
 */
export const ExtensionSwitches = keyedRegistry<boolean | undefined>("p2.extension-switches");

/**
 * Durable's registry over the worker's `Extensions` and `ExtensionSwitches`: a snapshot per (extensions, switched-off
 * set), made once and kept while the composition lives; `subscribe` observes both registries' compositions (its
 * listener called inside the Chord batch that composed, so it only wakes the scheduler). `context` ends the
 * observations.
 */
export function durableRegistry(
	extensions: RegistryValue<ReadonlyMap<string, Extension>>,
	switches: RegistryValue<ReadonlyMap<string, boolean | undefined>>,
	context: Context,
): RegistryReader {
	const snapshots = new WeakMap<ReadonlyMap<string, Extension>, Map<string, RegistrySnapshot>>();
	const snapshotOf = (table: ReadonlyMap<string, Extension>, disabled: ReadonlySet<string>): RegistrySnapshot => {
		const key = [...disabled].sort().join("\n");
		const byKey = snapshots.get(table) ?? new Map<string, RegistrySnapshot>();
		snapshots.set(table, byKey);
		let snapshot = byKey.get(key);
		if (snapshot === undefined) {
			const builder = createRegistry();
			for (const [name, extension] of table) if (!disabled.has(name)) builder.install(extension);
			snapshot = builder.snapshot();
			byKey.set(key, snapshot);
		}
		return snapshot;
	};
	const off = (): Set<string> => new Set([...switches.value].filter(([, on]) => on === false).map(([name]) => name));
	return {
		snapshot: () => snapshotOf(extensions.value, off()),
		subscribe: (listener) => {
			const observer = {
				advance: (call: { readonly kind: string }) => {
					// A failed composition keeps the last snapshot: nothing to reconsider.
					if (call.kind === "value") listener();
				},
				end: () => {},
			};
			const observations = [extensions.observe(observer, context), switches.observe(observer, context)];
			return () => {
				for (const observation of observations) observation.detach();
			};
		},
	};
}

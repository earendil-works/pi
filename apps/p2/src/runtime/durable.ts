// Durable on Chord v2 (Node): contexts, and the Harness's registry read from the worker's Chord registries of
// extensions and their switches, with every tool's requirements checked (`tool-access.ts`).
import type { RegistryValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createRegistry, type Extension, type RegistryReader, type RegistrySnapshot } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { keyedRegistry } from "./chord.ts";
import { guardTool, type P2Tool } from "./tool-access.ts";

/**
 * A Durable call context: a Chord handler's or routine's `ctx` is one already; a bare signal gets the background
 * context cancelled with it.
 */
export const durableContext = (ctx: Context | AbortSignal): Context =>
	ctx instanceof AbortSignal ? withAbortSignal(ctx, BACKGROUND_CONTEXT) : ctx;

/**
 * Durable extensions every conversation of the worker may select, by name (host-lifetime objects contribute them). Their
 * tools declare their requirements (`P2Tool`).
 */
export const Extensions = keyedRegistry<Extension<P2Tool>>("p2.durable-extensions");

/**
 * Live switches of contributed extensions, by extension name: an extension whose switch reads `false` is left out of
 * Durable's registry, as if uninstalled, until it reads `true` again. Example: the `codemode` setting. A contributor
 * contributes a watchable record (`self.derive([setting], ([on]) => ({ codemode: on }))`), which the registry follows.
 */
export const ExtensionSwitches = keyedRegistry<boolean | undefined>("p2.extension-switches");

/** The code mode plugin's extension: its switch is on while the `codemode` setting is, absent without the plugin. */
const CODEMODE_EXTENSION = "codemode";

/**
 * Durable's registry over the worker's `Extensions` and `ExtensionSwitches`: a snapshot per (extensions, switched-off
 * set), made once and kept while the composition lives. Without code mode, deferred tools the model may call (MCP
 * tools, the terminal tool) are reachable only through `tool_search`, as pi falls back: it is installed then, once,
 * whichever plugins offer such tools; `subscribe` observes both registries' compositions (its
 * listener called inside the Chord batch that composed, so it only wakes the scheduler). `context` ends the
 * observations.
 */
export function durableRegistry(
	extensions: RegistryValue<ReadonlyMap<string, Extension<P2Tool>>>,
	switches: RegistryValue<ReadonlyMap<string, boolean | undefined>>,
	context: Context,
): RegistryReader {
	const snapshots = new WeakMap<ReadonlyMap<string, Extension<P2Tool>>, Map<string, RegistrySnapshot>>();
	const snapshotOf = (
		table: ReadonlyMap<string, Extension<P2Tool>>,
		disabled: ReadonlySet<string>,
	): RegistrySnapshot => {
		const key = [...disabled].sort().join("\n");
		const byKey = snapshots.get(table) ?? new Map<string, RegistrySnapshot>();
		snapshots.set(table, byKey);
		let snapshot = byKey.get(key);
		if (snapshot === undefined) {
			const builder = createRegistry<P2Tool>();
			const installed = [...table].filter(([name]) => !disabled.has(name)).map(([, extension]) => extension);
			for (const extension of installed)
				builder.install(extension.tools ? { ...extension, tools: extension.tools.map(guardTool) } : extension);
			const codemode = table.has(CODEMODE_EXTENSION) && !disabled.has(CODEMODE_EXTENSION);
			const search = createToolSearchExtension();
			const deferred = installed.some((extension) =>
				extension.tools?.some((tool) => tool.deferred && (tool.callers?.includes("model") ?? true)),
			);
			if (!codemode && deferred && !table.has(search.name)) builder.install(search);
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

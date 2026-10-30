// Registry tokens (design §17, slice 8 D1): `defineRegistry`, shared by every plugin as a contract is (identity and
// types only), and what the defining plugin's facet serves it with (`compose`, `accepts`); the table `compose` gets and
// the composed value readers follow.

import type { Context } from "../../context/index.ts";
import type { NativeWatchable, Watchable } from "../../watch.ts";
import { checkName } from "../contracts/names.ts";
import type { NativeObservation, NativeObserver } from "../state/index.ts";

/**
 * A registry token: its name (as type names, `[a-z0-9@/._~-]`), the version the bundling plugin was built against, the
 * contribution type `C` and the composed value type `V`. Shared: every contributor and reader bundles its own copy.
 */
export type Registry<C, V> = {
	readonly kind: "registry";
	readonly name: string;
	readonly version: number;
	/** Type only: `C` in, `V` out. */
	readonly "~types"?: (contribution: C) => V;
};

/** One contribution in a registry's table: its plugin, its object type for an object contributor, its version. */
export type RegistryEntry<C> = {
	readonly plugin: string;
	/** The contributing object's type; absent for a facet. */
	readonly type?: string;
	/** The registry version its contributor was built against (an older one adapted to `C`). */
	readonly version: number;
	readonly value: C;
};

/** A registry's table: one entry per live contributor, sorted by plugin name, then type (a facet's first). */
export type RegistryTable<C> = readonly RegistryEntry<C>[];

/** A conflict `compose` resolved with its fallback: reported as `registry_conflict`, once per conflict episode. */
export type RegistryConflict = { readonly message: string; readonly plugins: readonly string[] };

/** What `compose` gets besides the table. */
export type ComposeContext = {
	/** Reports a conflict `compose` resolved (the first by plugin name wins, for example). */
	report(conflict: RegistryConflict): void;
};

/**
 * Adapters of older versions, by version, the provider's code: `contribution` maps an older contribution to `C` (once
 * per contribution value), `value` maps the composed value back for a reader of that version (once per composition).
 * A plugin annotates the old contribution's type (`(old: HttpV1) => upgrade(old)`).
 */
export type RegistryAccepts<C, V> = {
	readonly [version: number]: {
		readonly contribution?: (old: never) => C;
		readonly value?: (current: V) => unknown;
	};
};

/** What the defining plugin's facet serves a registry with (`host.serve(R, provider)`). */
export type RegistryProvider<C, V> = {
	/**
	 * Composes the table: pure and synchronous, always a value (a fallback built in), conflicts reported. Runs when the
	 * table changed and someone reads or follows the value; a throw is the owner's bug (`registry_failed`, the last
	 * good composition stays).
	 */
	readonly compose: (table: RegistryTable<C>, context: ComposeContext) => V;
	readonly accepts?: RegistryAccepts<C, V>;
};

/** What a contributor contributes: a plain value, or a Chord watchable of one (followed: its change recomposes). */
export type Contribution<C> = C | Watchable<C> | NativeWatchable<C>;

/**
 * A registry's composed value as a reader of one version sees it (`self.registry`, `host.registry`): a native
 * watchable; `.value` is the last good composition (a later throwing `compose` keeps it), a watch gets each new one.
 */
export interface RegistryValue<V> extends NativeWatchable<V> {
	/**
	 * A synchronous observer of its compositions (as Durable's `observeXXX`): `advance` runs inside the batch that
	 * composed, so it only records; an attached observer counts as watching, so the composition runs for it.
	 */
	observe(observer: NativeObserver<V>, context: Context): NativeObservation<V>;
}

/** Declares a registry token: `name` and the `version` this plugin is built against. */
export function defineRegistry<C, V>(name: string, options: { readonly version: number }): Registry<C, V> {
	checkName(name, "registry");
	const { version } = options;
	// Declaration policy: JavaScript callers reach this check.
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version: expected a positive integer`);
	return { kind: "registry", name, version };
}

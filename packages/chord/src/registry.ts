import type { Ctx } from "./types.ts";

export interface Registry<V> {
	readonly name: string;
	readonly conflict: "error" | "last";
	/** Type carrier only; never set. */
	readonly value?: V;
}

/** `conflict: "error"` rejects two objects registering one key; `"last"` keeps the later registration. */
export const defineRegistry = <V>(name: string, options: { conflict?: "error" | "last" } = {}): Registry<V> => ({
	name,
	conflict: options.conflict ?? "error",
});

export type RegistryTable<V> = ReadonlyMap<string, V>;

export interface RegistryView<V> {
	/** Table of `ctx.codeVersion`, or of the current code version without ctx. */
	table(ctx?: Ctx): RegistryTable<V>;
	get(key: string, ctx?: Ctx): V | undefined;
	/** Called with the current table immediately and whenever a new table is installed. */
	subscribe(listener: (table: RegistryTable<V>, codeVersion: number) => void): () => void;
}

export interface Registration {
	readonly registry: Registry<unknown>;
	readonly key: string;
	readonly value: unknown;
}

// The grantable model's Chord side: contracts built from a case, the provider plugins of both contracts and the
// world plugin (values, decisions, probes) the runner drives.

import type { BACKGROUND_CONTEXT as ctx } from "../../../src/context/index.ts";
import {
	type Contract,
	evolve,
	grantable,
	keyed,
	local,
	map,
	method,
	obj,
	remote,
	type Schema,
	str,
	unknown,
} from "../../../src/contracts/index.ts";
import { defineState, type StateDefinition } from "../../../src/documents/index.ts";
import { allow, defineFacet, deny, type FacetHost, type Self } from "../../../src/host/index.ts";
import type { PluginFacet } from "../../../src/host/staging.ts";
import type { JsonValue } from "../../../src/json.ts";
import { constant } from "../../../src/state/index.ts";
import type { Watchable } from "../../../src/watch.ts";
import { flagLabel, Server, type TestPrincipal } from "../../support.ts";
import {
	type AcceptsSpec,
	type Case,
	type Decision,
	decode,
	type Edit,
	encode,
	isGrantableName,
	type Kind,
	keyedMembersAt,
	keyedNeed,
	membersAt,
	needOf,
	poolOf,
	SHAPES,
	type Shape,
	type Who,
} from "./case.ts";
import type { World } from "./model.ts";

export type LooseEditor = { readonly [edit: string]: (...args: unknown[]) => LooseEditor };
export const looseRemote = remote as unknown as (name: string, declaration: object) => Contract;
export const looseEvolve = evolve as unknown as (
	previous: Contract,
	edit: (editor: LooseEditor) => LooseEditor,
) => Contract;

/** Every version's contract, oldest first. */
export function contractsOf(spec: Case, name: string): Contract[] {
	const declared = (member: string, schema: unknown) =>
		poolOf(spec, member).grantable ? grantable(schema as Schema) : schema;
	const first = membersAt(spec, 1);
	const section = (kind: Kind) =>
		Object.fromEntries(
			[...first]
				.filter(([member]) => poolOf(spec, member).kind === kind)
				.map(([member, shape]) => [member, declared(member, schemaOf(kind, shape))]),
		);
	const flags = Object.fromEntries(spec.flags.map((flag) => [flag, flagLabel(flag)]));
	const contracts = [
		looseRemote(name, {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			state: section("state"),
			events: section("event"),
			methods: section("method"),
			flags,
		}),
	];
	for (const edits of spec.versions.slice(1)) {
		contracts.push(
			looseEvolve(contracts.at(-1)!, (editor) => {
				for (const edit of edits) applyEdit(spec, editor, edit);
				return editor;
			}),
		);
	}
	return contracts;
}

export function schemaOf(kind: Kind, shape: Shape): unknown {
	return kind === "method" ? method(SHAPES[shape.a]!, SHAPES[shape.r]!) : SHAPES[shape.a]!;
}

export function applyEdit(spec: Case, editor: LooseEditor, edit: Edit): void {
	const { kind, grantable: marked } = poolOf(spec, edit.member);
	const Kind = kind === "state" ? "State" : kind === "event" ? "Event" : "Method";
	if (edit.op === "remove") {
		editor[`remove${Kind}`]!(edit.member);
		return;
	}
	const a = SHAPES[edit.shape.a]!;
	const r = SHAPES[edit.shape.r]!;
	if (edit.op === "add") {
		if (kind === "method") {
			if (marked) editor.addMethod!(edit.member, grantable(method(a, r)));
			else editor.addMethod!(edit.member, a, r);
		} else editor[`add${Kind}`]!(edit.member, marked ? grantable(a) : a);
		return;
	}
	if (kind === "state") editor.state!(edit.member, a);
	else if (kind === "event") editor.event!(edit.member, a);
	else if (edit.sides.length === 2) editor.method!(edit.member, a, r);
	else if (edit.sides[0] === "a") editor.args!(edit.member, a);
	else editor.result!(edit.member, r);
}

/** The values every state member derives from (`base`), kept by the test across the provider's restarts. */
export const Values = local("test.grantable-model.values", {
	version: 1,
	params: {},
	members: { base: map(str()), set: method(obj({ member: str(), value: str() })) },
});

/** The admission's decisions per principal kind, kept by the test across the provider's restarts. */
export const Access = local("test.grantable-model.access", {
	version: 1,
	params: {},
	members: { decisions: unknown(), set: method(unknown()) },
});

/**
 * One object per principal kind that every admission of the provider's object for it requests: it lives exactly while
 * that object does (its admission's requests are released when the object ends), which its open and close tell.
 */
export const Probe = local("test.grantable-model.probe", {
	version: 1,
	params: { who: str() },
	members: { ready: str() },
});

/** A factory pin of key "a" of the keyed contract's first keyed member at v1 (the keyed case's dependent). */
export const Pinned = local("test.grantable-model.pinned", { version: 1, params: {}, members: { n: str() } });

/** A live object's event sources, by member, with the shapes of its version (registered once it is live). */
export type Sources = Map<string, { readonly emit: (value: unknown) => void; readonly shape: Shape }>;

/** A call running on the old provider while it reloads: its handlers wait for `gate` once `entered` (a `busy` serve). */
export type Busy = { readonly entered: PromiseWithResolvers<void>; readonly gate: PromiseWithResolvers<void> };

/** What the test's plugins share with the runner. */
export type Shared = {
	readonly world: World;
	factories: number;
	/** Per principal kind, the last live attempt's event sources and its `self` (to fail it live). */
	readonly live: Map<string, Sources>;
	readonly selves: Map<string, Self>;
	/** Per principal kind, the open probes (`Probe`). */
	readonly probes: Map<string, number>;
	busy: Busy | undefined;
	/** The keyed contract's document definitions, by member: one each, so a reload keeps the documents. */
	readonly documents: Map<string, StateDefinition<{ n: string }, true, false>>;
};

/** Waits at a `busy` serve's gate, telling the runner the call runs. */
export async function enter(shared: Shared): Promise<void> {
	const busy = shared.busy;
	if (busy === undefined) return;
	busy.entered.resolve();
	await busy.gate.promise;
}

/**
 * The plugin serving `Values`, `Access`, `Probe` and, when the keyed contract's v1 has a keyed member, `Pinned`:
 * loaded once, never reloaded.
 */
export function worldPlugin(
	spec: Case,
	keyedContracts: readonly Contract[],
	shared: Shared,
): PluginFacet<TestPrincipal> {
	const pinned = [...keyedMembersAt(spec, 1)].find((member) => member.startsWith("k"));
	const facet = defineFacet<TestPrincipal>((h) => {
		h.serve(Probe, ({ who }, self) => {
			self.open(
				async () => {
					shared.probes.set(who, (shared.probes.get(who) ?? 0) + 1);
				},
				() => {
					shared.probes.set(who, shared.probes.get(who)! - 1);
				},
			);
			return { ready: constant("ready") };
		});
		if (pinned !== undefined) {
			h.serve(Pinned, (_params, self) => {
				const keyed = self.get(keyedContracts[0]!, {}) as unknown as Record<string, { at(key: string): Readable }>;
				return { n: self.derive([keyed[pinned]!.at("a")], ([doc]) => (doc as { n: string }).n) };
			});
		}
		h.serve(Values, (_params, self) => {
			const base = self.writable<Record<string, string>>({ ...shared.world.base });
			return {
				base: self.derive([base], ([value]) => value),
				set: async () => {
					base.set({ ...shared.world.base });
					return null;
				},
			};
		});
		h.serve(Access, (_params, self) => {
			const decisions = self.writable<JsonValue>(structuredClone(shared.world.decisions) as JsonValue);
			return {
				decisions: self.derive([decisions], ([value]) => value),
				set: async () => {
					decisions.set(structuredClone(shared.world.decisions) as JsonValue);
					return null;
				},
			};
		});
	});
	return { name: "@test/world", facet };
}

/** What a provider factory's `self` is used for here. */
export type ProviderSelf = {
	get(type: Contract, params: object): Record<string, unknown>;
	derive(sources: readonly unknown[], compute: (values: readonly unknown[]) => unknown): unknown;
	events(): { emit(value: unknown): void };
	onLive(routine: () => Promise<void>): void;
	open(opener: () => Promise<void>, close: () => void): void;
};

/** A readable a derive takes (a pin, a reference member): the loose factories pass them through. */
export type Readable = Watchable<unknown>;

export type LooseServe = (
	type: Contract,
	factory: (params: object, principal: TestPrincipal, admitted: unknown, self: ProviderSelf) => object,
	options: object,
) => void;

/** The provider of `contracts[version - 1]` with `accepts`, as one plugin. */
export function providerPlugin(
	spec: Case,
	contracts: readonly Contract[],
	version: number,
	accepts: AcceptsSpec,
	slow: boolean,
	shared: Shared,
): PluginFacet<TestPrincipal> {
	const now = membersAt(spec, version);
	const facet = defineFacet<TestPrincipal>((h: FacetHost<TestPrincipal>) => {
		(h.serve as unknown as LooseServe)(
			contracts[version - 1]!,
			(_params, principal, _admitted, self) => {
				shared.factories++;
				if (slow)
					self.open(
						() => new Promise((resolve) => setTimeout(resolve, 5)),
						() => {},
					);
				const values = self.get(Values, {});
				const sources: Sources = new Map();
				const members: Record<string, unknown> = {};
				for (const [member, shape] of now) {
					const { kind, grantable: marked } = poolOf(spec, member);
					let build: () => unknown;
					if (kind === "state") {
						build = () =>
							self.derive([values.base], ([base]) =>
								encode(shape.a, (base as Record<string, string>)[member] ?? `${member}.0`),
							);
					} else if (kind === "event") {
						build = () => {
							const source = self.events();
							sources.set(member, { emit: (value) => source.emit(value), shape });
							return source;
						};
					} else {
						build = () => async (args: unknown) => {
							await enter(shared);
							return encode(shape.r, `r:${decode(shape.a, args)}`);
						};
					}
					// A grantable state or event member is a builder; a method is the function either way.
					members[member] = marked && kind !== "method" ? build : build();
				}
				self.onLive(async () => {
					shared.live.set(principal.kind, sources);
					shared.selves.set(principal.kind, self as unknown as Self);
				});
				return members;
			},
			{
				admit: (_params: object, principal: TestPrincipal, self: ProviderSelf) =>
					self.derive(
						[self.get(Access, {}).decisions, self.get(Probe, { who: principal.kind }).ready],
						([all]) => {
							const decision = (all as Record<Who, Decision>)[principal.kind as Who];
							if (decision.kind === "deny") return deny(decision.reason, decision.message);
							const granted = decision.granted.filter((name) => isGrantableName(spec, name, now));
							return granted.length === 0 && decision.granted.length === 0 ? allow({}) : allow({ granted });
						},
					),
				accepts: acceptsTable(spec, version, accepts, shared),
			},
		);
	});
	return { name: "@test/provider", facet };
}

/** The accepts table of a provider at `provider`: identity-preserving mappings, or the case's refusals and calls. */
export function acceptsTable(
	spec: Case,
	provider: number,
	accepts: AcceptsSpec,
	shared: Shared,
): Record<number, object> {
	const now = membersAt(spec, provider);
	const table: Record<number, object> = {};
	for (const version of accepts.versions) {
		if (version >= provider) continue;
		const state: Record<string, unknown> = {};
		const events: Record<string, unknown> = {};
		const methods: Record<string, unknown> = {};
		for (const [member, shape] of membersAt(spec, version)) {
			const need = needOf(spec, version, provider, member);
			const choice = accepts.choices[`${version}:${member}`];
			const current = now.get(member);
			const back = (value: unknown) => encode(shape.a, decode(current!.a, value));
			const call = async (args: unknown) => {
				await enter(shared);
				return encode(shape.r, `c:${decode(shape.a, args)}`);
			};
			switch (need.kind) {
				case "none":
					break;
				case "state-changed":
					state[member] = back;
					break;
				case "state-removed":
					state[member] =
						choice === "refuse"
							? "refuse"
							: (all: Record<string, unknown>) => encode(shape.a, `rm:${Object.keys(all).sort().join(",")}`);
					break;
				case "event-changed":
					events[member] = choice === "refuse" ? "refuse" : back;
					break;
				case "method-removed":
					methods[member] = choice === "refuse" ? "refuse" : { call };
					break;
				case "method-changed":
					methods[member] =
						choice === "call"
							? { call }
							: {
									...(need.args ? { args: (old: unknown) => encode(current!.a, decode(shape.a, old)) } : {}),
									...(need.result
										? { result: (value: unknown) => encode(shape.r, decode(current!.r, value)) }
										: {}),
								};
					break;
			}
		}
		table[version] = { state, events, methods };
	}
	return table;
}

/** The keyed contract's documents' schema, and its `put`'s arguments. */
export const KeyedDocument = obj({ n: str() });
export const Put = obj({ member: str(), key: str(), value: str() });

/** Every version of the keyed contract, oldest first. */
export function keyedContractsOf(spec: Case, name: string): Contract[] {
	const first = Object.fromEntries(
		[...keyedMembersAt(spec, 1)].map((member) => [member, member.startsWith("k") ? keyed(KeyedDocument) : str()]),
	);
	const contracts = [
		(local as unknown as (name: string, declaration: object) => Contract)(name, {
			version: 1,
			params: {},
			members: { put: method(Put), ...first },
		}),
	];
	for (const edits of spec.keyed.versions.slice(1)) {
		contracts.push(
			looseEvolve(contracts.at(-1)!, (editor) => {
				for (const { op, member } of edits) {
					const keyedMember = member.startsWith("k");
					const schema = keyedMember ? KeyedDocument : str();
					const Kind = keyedMember ? "Keyed" : "State";
					if (op === "add") editor[`add${Kind}`]!(member, schema);
					else if (op === "remove") editor[`remove${Kind}`]!(member);
					else editor[keyedMember ? "keyed" : "state"]!(member, schema);
				}
				return editor;
			}),
		);
	}
	return contracts;
}

/** What a local factory's `self` is used for here. */
export type KeyedSelf = { state(definition: StateDefinition<{ n: string }, true, false>): KeyedDocuments };

/** A keyed document handle, as `put` changes it. */
export type KeyedDocuments = {
	change(key: string, edit: (draft: { n: string }) => void, context: typeof ctx): Promise<unknown>;
};

export type LooseLocalServe = (
	type: Contract,
	factory: (params: object, self: KeyedSelf) => object,
	options: object,
) => void;

/** The keyed contract's provider of `contracts[version - 1]` with `accepts`, as one plugin. */
export function keyedPlugin(
	spec: Case,
	contracts: readonly Contract[],
	version: number,
	accepts: AcceptsSpec,
	shared: Shared,
): PluginFacet<TestPrincipal> {
	const members = keyedMembersAt(spec, version);
	const facet = defineFacet<TestPrincipal>((h) => {
		(h.serve as unknown as LooseLocalServe)(
			contracts[version - 1]!,
			(_params, self) => {
				const documents = new Map<string, KeyedDocuments>();
				const exposed: Record<string, unknown> = {};
				for (const member of members) {
					if (!member.startsWith("k")) {
						exposed[member] = constant(member);
						continue;
					}
					let definition = shared.documents.get(member);
					if (definition === undefined) {
						definition = defineState(`kdoc.${member}`, {
							version: 1,
							schema: KeyedDocument,
							initial: () => ({ n: "" }),
							keyed: true,
						});
						shared.documents.set(member, definition);
					}
					const handle = self.state(definition);
					documents.set(member, handle);
					exposed[member] = handle;
				}
				const put = async (
					{ member, key, value }: { member: string; key: string; value: string },
					c: typeof ctx,
				) => {
					await documents.get(member)!.change(
						key,
						(draft) => {
							draft.n = value;
						},
						c,
					);
					return null;
				};
				return { ...exposed, put };
			},
			{ accepts: keyedAcceptsTable(spec, version, accepts) },
		);
	});
	return { name: "@test/keyed", facet };
}

/** The keyed provider's accepts: a changed member marks its value with the old version, or the case refuses it. */
export function keyedAcceptsTable(spec: Case, provider: number, accepts: AcceptsSpec): Record<number, object> {
	const table: Record<number, object> = {};
	for (const version of accepts.versions) {
		if (version >= provider) continue;
		const state: Record<string, unknown> = {};
		const keyedMappings: Record<string, unknown> = {};
		for (const member of keyedMembersAt(spec, version)) {
			const need = keyedNeed(spec, version, provider, member);
			const refused = accepts.choices[`${version}:${member}`] === "refuse";
			if (need === "none") continue;
			if (member.startsWith("k")) {
				keyedMappings[member] =
					need === "removed" || refused ? "refuse" : (doc: { n: string }) => ({ n: `${doc.n}@${version}` });
			} else if (need === "removed") state[member] = refused ? "refuse" : () => `rm@${version}`;
			else state[member] = (current: string) => `${current}@${version}`;
		}
		table[version] = { state, keyed: keyedMappings };
	}
	return table;
}

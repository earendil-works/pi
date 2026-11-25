// Model-based randomized test of grantable members (slice 15 §1) across contract versions (design §27) and lifecycles
// (design §6, §7). A seed generates a contract history (members added, changed, removed; plain and grantable; flags),
// providers of any of its versions with generated `accepts`, consumers of any version on the provider's host and over
// a link, and a walk of steps: holds, releases, admissions (allow with granted subsets, deny with and without a message,
// equal decisions), reloads to another version, the provider removed and back, link drops, value changes, emits and
// calls. After every step each consumer's reference is compared with `expected`, the model written from slice 15's
// rules. A failure is shrunk to a minimal case and printed with its seed.
//
// Runs: GRANTABLE_SEEDS (how many, default 25), GRANTABLE_FIRST_SEED (default 1), GRANTABLE_SEED (one seed),
// GRANTABLE_STEPS (steps per seed, default 30). A long run: GRANTABLE_SEEDS=2000 GRANTABLE_STEPS=60.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context/index.ts";
import {
	arr,
	type Contract,
	type EventMember,
	evolve,
	grantable,
	local,
	map,
	method,
	obj,
	remote,
	type Schema,
	str,
	unknown,
} from "../../src/contracts/index.ts";
import type { MessageData } from "../../src/data/index.ts";
import {
	allow,
	createHost,
	defineFacet,
	deny,
	type FacetHost,
	type Host,
	type HostError,
	type RefState,
} from "../../src/host/index.ts";
import type { PluginFacet } from "../../src/host/staging.ts";
import type { JsonValue } from "../../src/json.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import type { NativeWatchHandle } from "../../src/watch.ts";
import { Server, type TestPrincipal, testCodec } from "../support.ts";

// ---------------------------------------------------------------------------------------------------------------
// The generated case: a contract history, then steps. Plain data, so a failure can be shrunk and pasted back.

type Kind = "state" | "event" | "method";

/** A member of the history: its kind and whether it is grantable never change (slice 15 §1.1). */
type PoolMember = { readonly name: string; readonly kind: Kind; readonly grantable: boolean };

/** A member's schemas: `a` the state's or event's (a method's arguments), `r` a method's result. Indexes of SHAPES. */
type Shape = { readonly a: number; readonly r: number };

/** One edit of a version: `add` and `change` set the member's shape; `sides` are a method's changed sides. */
type Edit =
	| { readonly op: "add"; readonly member: string; readonly shape: Shape }
	| { readonly op: "remove"; readonly member: string }
	| { readonly op: "change"; readonly member: string; readonly shape: Shape; readonly sides: readonly ("a" | "r")[] };

type Decision =
	| { readonly kind: "allow"; readonly granted: readonly string[] }
	| { readonly kind: "deny"; readonly reason: string; readonly message?: MessageData };

type Who = "server" | "owner";

/** A provider's accepts: the older versions it accepts, and per `version:member` a choice where one is possible. */
type AcceptsSpec = {
	readonly versions: readonly number[];
	readonly choices: Readonly<Record<string, "refuse" | "call">>;
};

type Step =
	/** `slow`: its objects open a native that takes a few milliseconds, so their loading can be seen. */
	| { readonly kind: "serve"; readonly version: number; readonly accepts: AcceptsSpec; readonly slow?: boolean }
	| { readonly kind: "remove" }
	| { readonly kind: "hold"; readonly id: number; readonly version: number; readonly at: "local" | "link" }
	| { readonly kind: "release"; readonly id: number }
	| { readonly kind: "decide"; readonly who: Who; readonly decision: Decision }
	| { readonly kind: "drop" }
	| { readonly kind: "reconnect" }
	| { readonly kind: "value"; readonly member: string; readonly value: string }
	| { readonly kind: "emit" }
	| { readonly kind: "call" };

type Case = {
	readonly pool: readonly PoolMember[];
	readonly flags: readonly string[];
	/** Per version, from v1 (its edits are all `add`), the edits that made it. */
	readonly versions: readonly (readonly Edit[])[];
	readonly steps: readonly Step[];
};

// ---------------------------------------------------------------------------------------------------------------
// The model: what each consumer's reference shows, from slice 15 §1 and design §6, §7, §27.

/** What the world is after the steps so far. */
type World = {
	provider: { readonly version: number; readonly accepts: AcceptsSpec } | undefined;
	readonly decisions: Record<Who, Decision>;
	linkUp: boolean;
	readonly base: Record<string, string>;
};

/** What a reference keeps between bindings: its last binding's grant and values; placeholders until first live. */
type Memory = {
	readonly placeholders: boolean;
	readonly granted: readonly string[];
	readonly values: ReadonlyMap<string, JsonValue> | undefined;
};

type Status = "live" | "loading" | "waiting" | "denied";

/** What a read or a call gives: a value, or a throw with an error code (`*` in the model: any code). */
type Outcome =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "throws"; readonly code: string };

/** A member as a reference shows it: missing, there (method, event), or a state member's read. */
type MemberView = { readonly kind: "absent" } | { readonly kind: "present" } | Outcome;

const ABSENT: MemberView = { kind: "absent" };
const PRESENT: MemberView = { kind: "present" };

type View = {
	readonly status: Status;
	readonly granted: readonly string[];
	readonly members: Readonly<Record<string, MemberView>>;
	/** A denial's error: its message (the reason) and its `details.message`. */
	readonly denial?: { readonly reason: string; readonly message: MessageData | null };
};

type Consumer = { readonly id: number; readonly version: number; readonly at: "local" | "link" };

/** What the binding of `consumer` is in `world`, the link aside. */
type Binding =
	| { readonly kind: "waiting" }
	| { readonly kind: "denied"; readonly reason: string; readonly message: MessageData | null }
	| {
			readonly kind: "bound";
			/** What the consumer's version knows of the object's grant. */
			readonly granted: ReadonlySet<string>;
			readonly values: ReadonlyMap<string, JsonValue>;
	  };

/** The model: a consumer's binding. */
function bindingOf(spec: Case, world: World, consumer: Consumer): Binding {
	const provider = world.provider;
	// Not served, a newer consumer, or an older version not accepted: waiting unbound (§7, §27).
	if (provider === undefined || consumer.version > provider.version) return { kind: "waiting" };
	if (consumer.version < provider.version && !provider.accepts.versions.includes(consumer.version))
		return { kind: "waiting" };
	const decision = world.decisions[whoOf(consumer)];
	if (decision.kind === "deny") return { kind: "denied", reason: decision.reason, message: decision.message ?? null };
	const now = membersAt(spec, provider.version);
	const old = membersAt(spec, consumer.version);
	// The provider's admission grants what its version has (it filters); the consumer's version knows its own names.
	const objectGranted = new Set(decision.granted.filter((name) => isGrantableName(spec, name, now)));
	const granted = new Set([...objectGranted].filter((name) => isGrantableName(spec, name, old)));
	const visible = (member: string) => !poolOf(spec, member).grantable || granted.has(member);
	// A refused state or event member the consumer has (plain, or granted) refuses its binding (§27).
	for (const member of old.keys()) {
		const need = needOf(spec, consumer.version, provider.version, member).kind;
		const choice = provider.accepts.choices[`${consumer.version}:${member}`];
		if (visible(member) && (need === "state-removed" || need === "event-changed") && choice === "refuse")
			return { kind: "waiting" };
	}
	// A removed state member's mapping sees the current state its caller was granted (§27).
	const seen = [...now]
		.filter(
			([name]) => poolOf(spec, name).kind === "state" && (!poolOf(spec, name).grantable || objectGranted.has(name)),
		)
		.map(([name]) => name)
		.sort();
	const values = new Map<string, JsonValue>();
	for (const [member, shape] of old) {
		if (poolOf(spec, member).kind !== "state" || !visible(member)) continue;
		values.set(member, encode(shape.a, now.has(member) ? baseOf(world, member) : `rm:${seen.join(",")}`));
	}
	return { kind: "bound", granted, values };
}

/** The model: what `consumer` shows, and what it remembers after. */
function expected(spec: Case, world: World, consumer: Consumer, memory: Memory): { view: View; memory: Memory } {
	// A link drop: loading, the last binding's grant and values (§7).
	if (consumer.at === "link" && !world.linkUp) return { view: remembered(spec, consumer, memory, "loading"), memory };
	const binding = bindingOf(spec, world, consumer);
	switch (binding.kind) {
		case "waiting":
			return { view: remembered(spec, consumer, memory, "waiting"), memory };
		case "denied": {
			// A denial keeps no value, empties `granted`, and its grantable members are gone (slice 14, slice 15 §1.4).
			const members: Record<string, MemberView> = {};
			for (const [member] of membersAt(spec, consumer.version)) {
				const { kind, grantable } = poolOf(spec, member);
				members[member] = grantable ? ABSENT : kind === "state" ? thrown("forbidden") : PRESENT;
			}
			const view: View = {
				status: "denied",
				granted: [],
				members,
				denial: { reason: binding.reason, message: binding.message },
			};
			return { view, memory: { placeholders: false, granted: [], values: undefined } };
		}
		case "bound": {
			const granted = [...binding.granted].sort();
			const next: Memory = { placeholders: false, granted, values: binding.values };
			return { view: remembered(spec, consumer, next, "live"), memory: next };
		}
	}
}

/** A view from what the reference remembers: until first live every grantable member is there (slice 15 §1.4). */
function remembered(spec: Case, consumer: Consumer, memory: Memory, status: Status): View {
	const members: Record<string, MemberView> = {};
	for (const [member] of membersAt(spec, consumer.version)) {
		const { kind, grantable } = poolOf(spec, member);
		const there = !grantable || memory.placeholders || memory.granted.includes(member);
		if (!there) members[member] = ABSENT;
		else if (kind !== "state") members[member] = PRESENT;
		else {
			const value = memory.values?.get(member);
			members[member] = value === undefined ? thrown("*") : { kind: "value", value };
		}
	}
	return { status, granted: memory.granted, members };
}

/** The model: what a call of `member` with `x` gives a consumer showing `view` (a code when it fails). */
function expectedCall(spec: Case, world: World, consumer: Consumer, view: View, member: string, x: string): Outcome {
	if (view.status === "denied") return thrown("forbidden");
	if (view.status === "waiting") return thrown("*");
	if (!view.granted.includes(member) && poolOf(spec, member).grantable) return thrown("forbidden");
	const provider = world.provider!;
	const shape = membersAt(spec, consumer.version).get(member)!;
	const need = needOf(spec, consumer.version, provider.version, member);
	const choice = provider.accepts.choices[`${consumer.version}:${member}`];
	if (need.kind === "method-removed" && choice === "refuse") return thrown("contract_mismatch");
	const replaced = need.kind === "method-removed" || (need.kind === "method-changed" && choice === "call");
	return { kind: "value", value: encode(shape.r, `${replaced ? "c" : "r"}:${x}`) };
}

function thrown(code: string): Outcome {
	return { kind: "throws", code };
}

/** The model: what an emit of every built event member gives a consumer (member, value), in member order. */
function expectedEvents(spec: Case, world: World, consumer: Consumer, view: View, emitted: Emitted): Received[] {
	if (view.status !== "live") return [];
	const binding = bindingOf(spec, world, consumer);
	if (binding.kind !== "bound") return [];
	const received: Received[] = [];
	for (const [member, shape] of membersAt(spec, consumer.version)) {
		const value = emitted.get(whoOf(consumer))?.get(member);
		const { kind, grantable } = poolOf(spec, member);
		if (kind !== "event" || value === undefined || (grantable && !binding.granted.has(member))) continue;
		received.push({ member, value: encode(shape.a, value) });
	}
	return received;
}

// ---------------------------------------------------------------------------------------------------------------
// The history's derived data, shared by the model and the provider's code.

const SHAPES: readonly Schema[] = [str(), obj({ v: str() }), arr(str())];

/** `x` in shape `shape`. */
function encode(shape: number, x: string): JsonValue {
	return shape === 0 ? x : shape === 1 ? { v: x } : [x];
}

/** The string in a value of shape `shape`. */
function decode(shape: number, value: unknown): string {
	return shape === 0 ? (value as string) : shape === 1 ? (value as { v: string }).v : (value as string[])[0]!;
}

function poolOf(spec: Case, member: string): PoolMember {
	return spec.pool.find(({ name }) => name === member)!;
}

/** A name a version's admission may grant: a grantable member it has, or a flag. */
function isGrantableName(spec: Case, name: string, members: ReadonlyMap<string, Shape>): boolean {
	return spec.flags.includes(name) || (members.has(name) && poolOf(spec, name).grantable);
}

/** The members of version `version` (from 1) and their shapes, in pool order. */
function membersAt(spec: Case, version: number): ReadonlyMap<string, Shape> {
	const members = new Map<string, Shape>();
	for (const edits of spec.versions.slice(0, version)) {
		for (const edit of edits) {
			if (edit.op === "remove") members.delete(edit.member);
			else members.set(edit.member, edit.shape);
		}
	}
	const order = spec.pool.map(({ name }) => name);
	return new Map([...members].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
}

/** What a provider at `provider` needs for `member` of an older `version` (§27: by edit, never by schema). */
type Need =
	| { readonly kind: "none" | "state-changed" | "state-removed" | "event-changed" | "method-removed" }
	| { readonly kind: "method-changed"; readonly args: boolean; readonly result: boolean };

function needOf(spec: Case, version: number, provider: number, member: string): Need {
	const old = membersAt(spec, version);
	const now = membersAt(spec, provider);
	if (version >= provider || !old.has(member)) return { kind: "none" };
	const { kind } = poolOf(spec, member);
	const edits = spec.versions.slice(version, provider).flatMap((list) => list.filter((e) => e.member === member));
	const touched = (side: "a" | "r") =>
		edits.some((edit) => edit.op === "add" || (edit.op === "change" && edit.sides.includes(side)));
	if (!now.has(member)) {
		if (kind === "state") return { kind: "state-removed" };
		return kind === "method" ? { kind: "method-removed" } : { kind: "none" };
	}
	if (kind === "method") {
		const [args, result] = [touched("a"), touched("r")];
		return args || result ? { kind: "method-changed", args, result } : { kind: "none" };
	}
	if (!touched("a")) return { kind: "none" };
	return { kind: kind === "state" ? "state-changed" : "event-changed" };
}

function whoOf(consumer: Consumer): Who {
	return consumer.at === "local" ? "server" : "owner";
}

function baseOf(world: World, member: string): string {
	return world.base[member] ?? `${member}.0`;
}

// ---------------------------------------------------------------------------------------------------------------
// Contracts and the provider, built from a case. Members are dynamic here, so the declarations go through loose
// signatures: the case decides at runtime what the types would decide at compile time.

type LooseEditor = { readonly [edit: string]: (...args: unknown[]) => LooseEditor };
const looseRemote = remote as unknown as (name: string, declaration: object) => Contract;
const looseEvolve = evolve as unknown as (previous: Contract, edit: (editor: LooseEditor) => LooseEditor) => Contract;

/** Every version's contract, oldest first. */
function contractsOf(spec: Case, name: string): Contract[] {
	const declared = (member: string, schema: unknown) =>
		poolOf(spec, member).grantable ? grantable(schema as Schema) : schema;
	const first = membersAt(spec, 1);
	const section = (kind: Kind) =>
		Object.fromEntries(
			[...first]
				.filter(([member]) => poolOf(spec, member).kind === kind)
				.map(([member, shape]) => [member, declared(member, schemaOf(kind, shape))]),
		);
	const flags = Object.fromEntries(spec.flags.map((flag) => [flag, `Flag ${flag}`]));
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

function schemaOf(kind: Kind, shape: Shape): unknown {
	return kind === "method" ? method(SHAPES[shape.a]!, SHAPES[shape.r]!) : SHAPES[shape.a]!;
}

function applyEdit(spec: Case, editor: LooseEditor, edit: Edit): void {
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
const Values = local("test.grantable-model.values", {
	version: 1,
	params: {},
	members: { base: map(str()), set: method(obj({ member: str(), value: str() })) },
});

/** The admission's decisions per principal kind, kept by the test across the provider's restarts. */
const Access = local("test.grantable-model.access", {
	version: 1,
	params: {},
	members: { decisions: unknown(), set: method(unknown()) },
});

/** A live object's event sources, by member, with the shapes of its version (registered once it is live). */
type Sources = Map<string, { readonly emit: (value: unknown) => void; readonly shape: Shape }>;

/** What the test's plugins share with the runner. */
type Shared = { readonly world: World; factories: number; readonly live: Map<string, Sources> };

/** The plugin serving `Values` and `Access`: loaded once, never reloaded. */
function worldPlugin(shared: Shared): PluginFacet<TestPrincipal> {
	const facet = defineFacet<TestPrincipal>((h) => {
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
type ProviderSelf = {
	get(type: Contract, params: object): Record<string, unknown>;
	derive(sources: readonly unknown[], compute: (values: readonly unknown[]) => unknown): unknown;
	events(): { emit(value: unknown): void };
	onLive(routine: () => Promise<void>): void;
	open(opener: () => Promise<void>, close: () => void): void;
};

type LooseServe = (
	type: Contract,
	factory: (params: object, principal: TestPrincipal, admitted: unknown, self: ProviderSelf) => object,
	options: object,
) => void;

/** The provider of `contracts[version - 1]` with `accepts`, as one plugin. */
function providerPlugin(
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
						build = () => async (args: unknown) => encode(shape.r, `r:${decode(shape.a, args)}`);
					}
					// A grantable state or event member is a builder; a method is the function either way.
					members[member] = marked && kind !== "method" ? build : build();
				}
				self.onLive(async () => {
					shared.live.set(principal.kind, sources);
				});
				return members;
			},
			{
				admit: (_params: object, principal: TestPrincipal, self: ProviderSelf) =>
					self.derive([self.get(Access, {}).decisions], ([all]) => {
						const decision = (all as Record<Who, Decision>)[principal.kind as Who];
						if (decision.kind === "deny") return deny(decision.reason, decision.message);
						const granted = decision.granted.filter((name) => isGrantableName(spec, name, now));
						return granted.length === 0 && decision.granted.length === 0 ? allow({}) : allow({ granted });
					}),
				accepts: acceptsTable(spec, version, accepts),
			},
		);
	});
	return { name: "@test/provider", facet };
}

/** The accepts table of a provider at `provider`: identity-preserving mappings, or the case's refusals and calls. */
function acceptsTable(spec: Case, provider: number, accepts: AcceptsSpec): Record<number, object> {
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
			const call = async (args: unknown) => encode(shape.r, `c:${decode(shape.a, args)}`);
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

// ---------------------------------------------------------------------------------------------------------------
// The runner: runs a case against Chord, comparing with the model after every step.

/** A reference of a dynamic contract version. */
type DynRef = {
	readonly granted: ReadonlySet<string>;
	readonly state: { readonly value: RefState; watch(context: typeof ctx): Promise<NativeWatchHandle<RefState>> };
	release(): void;
	readonly [member: string]: unknown;
};

type Received = { readonly member: string; readonly value: JsonValue };

/** Per principal kind, the value emitted per member. */
type Emitted = Map<Who, Map<string, string>>;

/** A consumer as the runner follows it. */
type Held = Consumer & {
	readonly ref: DynRef;
	memory: Memory;
	view: View;
	/** Every member object seen, by name: a member keeps its identity across bindings. */
	readonly handles: Map<string, unknown>;
	/** The event members subscribed to, by name. */
	readonly subscribed: Set<string>;
	readonly received: Received[];
	readonly violations: string[];
	/** The grant it showed when last seen live (by its state watch or a check); empty after a denial. */
	lastGranted: readonly string[];
};

/** A failure: the step it happened at, its category (what shrinking keeps), and what was seen. */
type Failure = { readonly step: number; readonly category: string; readonly message: string };

const SETTLE_MIN = 12;
const SETTLE_MAX = 600;

/** Runs `spec`; the first failure, if any. */
async function run(spec: Case, seed = 0): Promise<Failure | undefined> {
	let contracts: Contract[];
	try {
		contracts = contractsOf(spec, `test.grantable-model.c${seed}`);
	} catch (error) {
		return { step: -1, category: "declaration", message: String(error) };
	}
	const world: World = {
		provider: undefined,
		decisions: { server: { kind: "allow", granted: [] }, owner: { kind: "allow", granted: [] } },
		linkUp: true,
		base: {},
	};
	const shared: Shared = { world, factories: 0, live: new Map() };
	const errors: string[] = [];
	const report = (where: string) => (error: HostError) =>
		errors.push(`${where}: ${JSON.stringify(error)}`.slice(0, 300));
	const server = createHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		onError: report("server"),
	});
	const client = createHost<TestPrincipal>({ onError: report("client") });
	const world$ = worldPlugin(shared);
	await server.load([world$], ctx);
	await client.load([], ctx);
	let clientLink = connect(server, client);
	const consumers = new Map<number, Held>();
	let emitted: Emitted = new Map();
	let emits = 0;
	const fail = (step: number, category: string, message: string): Failure => ({
		step,
		category,
		message: `${message}${errors.length > 0 ? `\nhost errors:\n  ${errors.slice(-5).join("\n  ")}` : ""}`,
	});
	try {
		for (const [index, step] of spec.steps.entries()) {
			const factoriesBefore = shared.factories;
			const equalDecision =
				step.kind === "decide" &&
				sameDecision(world.decisions[step.who], step.decision) &&
				world.provider !== undefined;
			emitted = new Map();
			switch (step.kind) {
				case "serve": {
					world.provider = { version: step.version, accepts: step.accepts };
					const plugin = providerPlugin(spec, contracts, step.version, step.accepts, step.slow === true, shared);
					const reloaded = await server.reload([world$, plugin], ctx);
					if (reloaded.failed.length > 0)
						return fail(index, "reload", `the provider did not load: ${JSON.stringify(reloaded.failed)}`);
					break;
				}
				case "remove":
					world.provider = undefined;
					await server.reload([world$], ctx);
					break;
				case "hold": {
					const consumer = { id: step.id, version: step.version, at: step.at };
					const host = step.at === "local" ? server : client;
					const ref = host.hold(contracts[step.version - 1]!, {}, ctx) as unknown as DynRef;
					const held: Held = {
						...consumer,
						ref,
						memory: { placeholders: true, granted: [], values: undefined },
						view: { status: "loading", granted: [], members: {} },
						handles: new Map(),
						subscribed: new Set(),
						received: [],
						violations: [],
						lastGranted: [],
					};
					consumers.set(step.id, held);
					watchInvariant(spec, held);
					break;
				}
				case "release":
					consumers.get(step.id)?.ref.release();
					consumers.delete(step.id);
					break;
				case "decide": {
					world.decisions[step.who] = step.decision;
					const access = await server.get(Access, {}, ctx);
					await access.set(null, ctx);
					access.release();
					break;
				}
				case "drop":
					world.linkUp = false;
					clientLink.close();
					break;
				case "reconnect":
					world.linkUp = true;
					clientLink = connect(server, client);
					break;
				case "value": {
					world.base[step.member] = step.value;
					const values = await server.get(Values, {}, ctx);
					await values.set({ member: step.member, value: "" }, ctx);
					values.release();
					break;
				}
				case "emit":
					for (const held of consumers.values()) await subscribe(spec, held);
					for (const [who, sources] of shared.live) {
						const sent = new Map<string, string>();
						for (const [member, { emit, shape }] of sources) {
							const value = `e${++emits}`;
							try {
								emit(encode(shape.a, value));
								sent.set(member, value);
							} catch {
								// A sealed attempt's source: nothing is emitted.
							}
						}
						emitted.set(who as Who, sent);
					}
					break;
				case "call": {
					const mismatch = await checkCalls(spec, world, consumers, index);
					if (mismatch !== undefined) return fail(index, "call", mismatch);
					break;
				}
			}
			for (const held of consumers.values()) {
				const next = expected(spec, world, held, held.memory);
				held.view = next.view;
				held.memory = next.memory;
			}
			const mismatch = await settle(() => compareAll(spec, world, consumers, emitted));
			if (mismatch !== undefined) return fail(index, mismatch.category, mismatch.message);
			for (const held of consumers.values()) {
				await subscribe(spec, held);
				held.received.length = 0;
			}
			if (equalDecision && shared.factories !== factoriesBefore)
				return fail(index, "rebuild", "an equal decision ran the factory again");
		}
		return undefined;
	} catch (error) {
		return fail(-1, "crash", String((error as Error)?.stack ?? error));
	} finally {
		for (const held of consumers.values()) held.ref.release();
		await client.close(ctx);
		await server.close(ctx);
	}
}

/** A link from `client` to `server`, the server's side acting as the owner. */
function connect(server: Host<TestPrincipal>, client: Host<TestPrincipal>) {
	const [serverEnd, clientEnd] = memoryLinkPair();
	server.accept(serverEnd, { principal: { kind: "owner" }, codec: testCodec() }, ctx);
	client.connect(clientEnd, { principal: { kind: "server" }, codec: testCodec() }, ctx);
	return clientEnd;
}

function sameDecision(a: Decision, b: Decision): boolean {
	if (a.kind === "allow" && b.kind === "allow")
		return [...new Set(a.granted)].sort().join() === [...new Set(b.granted)].sort().join();
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Checks on every state the reference reports, while it is still the current kind: live, a grantable member is there
 * exactly when `granted` has it and a granted state member reads (slice 15 §1.4, §7 test 8: `granted` and the members
 * change in one batch); loading or failed (not denied), `granted` is the last live binding's, empty before the first
 * and after a denial (§1.4: a rebind, a replacement loading, a link drop keep it).
 */
function watchInvariant(spec: Case, held: Held): void {
	void held.ref.state.watch(ctx).then((watch) =>
		watch.start(async (call) => {
			if (call.kind !== "value" || held.ref.state.value.kind !== call.value.kind) return;
			const state = call.value;
			const granted = [...held.ref.granted].sort();
			if (state.kind === "failed" && state.cause.kind === "denied") held.lastGranted = [];
			if (state.kind === "loading" || (state.kind === "failed" && state.cause.kind !== "denied")) {
				if (granted.join() !== held.lastGranted.join())
					held.violations.push(
						`${state.kind} with granted [${granted}], its last binding's [${held.lastGranted}]`,
					);
			}
			if (state.kind !== "live") return;
			held.lastGranted = granted;
			for (const [member] of membersAt(spec, held.version)) {
				const { kind, grantable: marked } = poolOf(spec, member);
				if (!marked) continue;
				const there = held.ref[member] !== undefined;
				if (there !== held.ref.granted.has(member))
					held.violations.push(
						`live with granted [${[...held.ref.granted]}] and member ${member} ${there ? "there" : "missing"}`,
					);
				else if (there && kind === "state") {
					try {
						(held.ref[member] as { value: unknown }).value;
					} catch (error) {
						held.violations.push(`live, granted ${member}, its read throws ${codeOf(error)}`);
					}
				}
			}
		}),
	);
}

/** Subscribes to every event member the reference shows that it has not subscribed to yet. */
async function subscribe(spec: Case, held: Held): Promise<void> {
	for (const [member] of membersAt(spec, held.version)) {
		const handle = held.ref[member] as EventMember<JsonValue> | undefined;
		if (poolOf(spec, member).kind !== "event" || handle === undefined || held.subscribed.has(member)) continue;
		held.subscribed.add(member);
		await handle.on(({ value }) => held.received.push({ member, value }), ctx);
	}
}

/** Waits until every consumer shows what the model expects, and keeps showing it; else the last mismatch. */
async function settle(compare: () => Failure | undefined): Promise<Failure | undefined> {
	let stable = 0;
	let last: Failure | undefined;
	for (let round = 0; round < SETTLE_MAX; round++) {
		if (round % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
		else await new Promise((resolve) => setImmediate(resolve));
		last = compare();
		stable = last === undefined ? stable + 1 : 0;
		if (stable >= 4 && round >= SETTLE_MIN) return undefined;
	}
	return last;
}

function compareAll(
	spec: Case,
	world: World,
	consumers: ReadonlyMap<number, Held>,
	emitted: Emitted,
): Failure | undefined {
	for (const held of consumers.values()) {
		const label = `c${held.id} (v${held.version} ${held.at})`;
		if (held.violations.length > 0)
			return { step: 0, category: "invariant", message: `${label}: ${held.violations[0]}` };
		const seen = observe(spec, held);
		const field = differs(held.view, seen);
		if (field !== undefined) {
			const mismatch =
				field === "status" ? `${held.view.status} shown ${seen.status}` : `${held.view.status}: ${field}`;
			return {
				step: 0,
				category: `${mismatch} (${held.at})`,
				message: `${label} ${mismatch}:\n  expected ${JSON.stringify(held.view)}\n  saw      ${JSON.stringify(seen)}`,
			};
		}
		const events = expectedEvents(spec, world, held, held.view, emitted);
		const got = [...held.received].sort((a, b) => a.member.localeCompare(b.member));
		if (JSON.stringify(events) !== JSON.stringify(got))
			return {
				step: 0,
				category: "event",
				message: `${label} events:\n  expected ${JSON.stringify(events)}\n  saw      ${JSON.stringify(got)}`,
			};
	}
	return undefined;
}

/** What a reference shows now, in the model's terms (an identity change of a member is a violation). */
function observe(spec: Case, held: Held): View {
	const state = held.ref.state.value;
	const status = state.kind === "failed" ? state.cause.kind : state.kind;
	const members: Record<string, MemberView> = {};
	for (const [member] of membersAt(spec, held.version)) {
		const handle = held.ref[member];
		if (handle === undefined) {
			members[member] = ABSENT;
			continue;
		}
		const known = held.handles.get(member);
		if (known !== undefined && known !== handle)
			held.violations.push(`member ${member} is another object than before`);
		held.handles.set(member, handle);
		if (poolOf(spec, member).kind !== "state") members[member] = PRESENT;
		else {
			try {
				members[member] = { kind: "value", value: (handle as { value: JsonValue }).value };
			} catch (error) {
				members[member] = thrown(codeOf(error));
			}
		}
	}
	const view: View = { status: status as Status, granted: [...held.ref.granted].sort(), members };
	// A reference joining a live shared hold is live before its state watch starts.
	if (state.kind === "live") held.lastGranted = view.granted;
	if (state.kind === "failed" && state.cause.kind === "denied") {
		const error = state.cause.error;
		const details = error.details as { message?: MessageData } | undefined;
		return { ...view, denial: { reason: error.message, message: details?.message ?? null } };
	}
	return view;
}

/** The first field of `seen` that is not what `expected` says, by category; `*` matches any code. */
function differs(expected: View, seen: View): string | undefined {
	if (expected.status !== seen.status) return "status";
	if (expected.granted.join() !== seen.granted.join()) return "granted";
	for (const [member, want] of Object.entries(expected.members)) {
		const got = seen.members[member];
		if (want.kind === "absent" || got?.kind === "absent") {
			if (want.kind !== got?.kind) return "member presence";
		} else if (want.kind === "present" || got?.kind === "present") {
			if (want.kind !== got?.kind) return "member kind";
		} else if (got === undefined || !fits(want, got)) return want.kind === "value" ? "member value" : "member read";
	}
	if (JSON.stringify(expected.denial) !== JSON.stringify(seen.denial)) return "denial";
	return undefined;
}

/** Calls every method of every settled consumer and compares with the model. */
async function checkCalls(
	spec: Case,
	world: World,
	consumers: ReadonlyMap<number, Held>,
	step: number,
): Promise<string | undefined> {
	for (const held of consumers.values()) {
		if (held.view.status === "loading") continue;
		for (const [member, shape] of membersAt(spec, held.version)) {
			if (poolOf(spec, member).kind !== "method") continue;
			// A member the reference does not show is called through the handle it showed before, if any.
			const handle = (held.ref[member] ?? held.handles.get(member)) as
				| ((args: unknown, context: typeof ctx) => Promise<unknown>)
				| undefined;
			if (handle === undefined) continue;
			const x = `x${step}`;
			const want = expectedCall(spec, world, held, held.view, member, x);
			const got = await callResult(handle(encode(shape.a, x), ctx));
			if (!fits(want, got))
				return `c${held.id} (v${held.version} ${held.at}, ${held.view.status}, granted [${held.view.granted}]) ${member}(): expected ${JSON.stringify(want)}, saw ${JSON.stringify(got)}`;
		}
	}
	return undefined;
}

/** Whether `got` is what the model's `want` says: an equal value, or a throw with its code (`*`: any). */
function fits(want: Outcome, got: Outcome): boolean {
	if (want.kind === "value") return got.kind === "value" && JSON.stringify(got.value) === JSON.stringify(want.value);
	return got.kind === "throws" && (want.code === "*" || want.code === got.code);
}

async function callResult(call: Promise<unknown>): Promise<Outcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Outcome>((resolve) => {
		timer = setTimeout(() => resolve(thrown("(no answer in 2 s)")), 2000);
	});
	try {
		return await Promise.race([
			call.then((value): Outcome => ({ kind: "value", value: value as JsonValue })),
			timeout,
		]);
	} catch (error) {
		return thrown(codeOf(error));
	} finally {
		clearTimeout(timer);
	}
}

function codeOf(error: unknown): string {
	return (error as { code?: string })?.code ?? String(error);
}

// ---------------------------------------------------------------------------------------------------------------
// Generating cases from a seed, shrinking a failing one, and printing it.

/** A seeded generator of numbers in [0, 1) (mulberry32). */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The case of `seed`: a history of 1 to 4 versions over 3 to 6 members, and `count` steps. */
function generate(seed: number, count: number): Case {
	const rand = random(seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
	const chance = (p: number) => rand() < p;
	const shape = (): Shape => ({ a: pick([0, 1, 2]), r: pick([0, 1, 2]) });
	const pool: PoolMember[] = Array.from({ length: 3 + Math.floor(rand() * 4) }, (_, index) => {
		const kind = pick<Kind>(["state", "event", "method"]);
		return { name: `${kind[0]}${index}`, kind, grantable: chance(0.5) };
	});
	const flags = chance(0.5) ? ["f0"] : ["f0", "f1"];
	const versions: Edit[][] = [
		pool.filter(() => chance(0.7)).map(({ name }) => ({ op: "add", member: name, shape: shape() })),
	];
	const total = 1 + Math.floor(rand() * 4);
	while (versions.length < total) {
		const present = membersAt({ pool, flags, versions, steps: [] }, versions.length);
		const edits: Edit[] = [];
		for (let edit = 0; edit < 1 + Math.floor(rand() * 3); edit++) {
			const { name, kind } = pick(pool);
			if (edits.some(({ member }) => member === name)) continue;
			const old = present.get(name);
			if (old === undefined) edits.push({ op: "add", member: name, shape: shape() });
			else if (chance(0.3)) edits.push({ op: "remove", member: name });
			else {
				const sides =
					kind === "method" ? pick<("a" | "r")[]>([["a"], ["r"], ["a", "r"]]) : (["a"] as ("a" | "r")[]);
				const next = shape();
				const changed = { a: sides.includes("a") ? next.a : old.a, r: sides.includes("r") ? next.r : old.r };
				edits.push({ op: "change", member: name, shape: changed, sides });
			}
		}
		versions.push(edits);
	}
	const spec: Case = { pool, flags, versions, steps: [] };
	const serve = (): Step => {
		// The newest version half the time: older consumers then meet their mappings.
		const version = chance(0.5) ? total : 1 + Math.floor(rand() * total);
		const accepted = Array.from({ length: version - 1 }, (_, index) => index + 1).filter(() => chance(0.8));
		const choices: Record<string, "refuse" | "call"> = {};
		for (const old of accepted) {
			for (const [member] of membersAt(spec, old)) {
				const need = needOf(spec, old, version, member).kind;
				if (need === "state-removed" || need === "event-changed" || need === "method-removed") {
					if (chance(0.25)) choices[`${old}:${member}`] = "refuse";
				} else if (need === "method-changed" && chance(0.3)) choices[`${old}:${member}`] = "call";
			}
		}
		return { kind: "serve", version, accepts: { versions: accepted, choices }, slow: chance(0.3) };
	};
	const names = [...pool.filter(({ grantable }) => grantable).map(({ name }) => name), ...flags];
	const decisions: Record<Who, Decision> = {
		server: { kind: "allow", granted: [] },
		owner: { kind: "allow", granted: [] },
	};
	const decide = (): Step => {
		const who = pick<Who>(["server", "owner"]);
		const roll = rand();
		let decision: Decision;
		if (roll < 0.55) {
			const granted = names.filter(() => chance(0.5)).sort(() => rand() - 0.5);
			decision = { kind: "allow", granted: chance(0.2) && granted.length > 0 ? [...granted, granted[0]!] : granted };
		} else if (roll < 0.85) {
			// Reason and message vary on their own: a changed message alone is a new decision (slice 15 §2).
			const [n, m] = [Math.floor(rand() * 2), Math.floor(rand() * 2)];
			decision = chance(0.5)
				? {
						kind: "deny",
						reason: `no access ${n}`,
						message: { namespace: "test", key: `denied.${m}`, params: [m] },
					}
				: { kind: "deny", reason: `no access ${n}` };
		} else {
			// The same decision again, its names in another order (slice 15 §1.2).
			const current = decisions[who];
			decision = current.kind === "allow" ? { kind: "allow", granted: [...current.granted].reverse() } : current;
		}
		decisions[who] = decision;
		return { kind: "decide", who, decision };
	};
	const steps: Step[] = [serve()];
	let served = true;
	let linkUp = true;
	let nextId = 1;
	const alive: number[] = [];
	const stateMembers = pool.filter(({ kind }) => kind === "state").map(({ name }) => name);
	while (steps.length < count) {
		const options: [number, () => Step | undefined][] = [
			[
				alive.length < 6 ? 3 : 0,
				() => {
					const id = nextId++;
					alive.push(id);
					return {
						kind: "hold",
						id,
						version: 1 + Math.floor(rand() * total),
						at: pick(["local", "link"] as const),
					};
				},
			],
			[
				alive.length > 0 ? 1 : 0,
				() => ({ kind: "release", id: alive.splice(Math.floor(rand() * alive.length), 1)[0]! }),
			],
			[3, decide],
			[
				2,
				() => {
					served = true;
					return serve();
				},
			],
			[
				served ? 0.7 : 0,
				() => {
					served = false;
					return { kind: "remove" };
				},
			],
			[
				linkUp ? 0.5 : 2,
				() => {
					linkUp = !linkUp;
					return { kind: linkUp ? "reconnect" : "drop" };
				},
			],
			[
				stateMembers.length > 0 ? 1.5 : 0,
				() => ({ kind: "value", member: pick(stateMembers), value: `v${steps.length}` }),
			],
			[1.5, () => ({ kind: "emit" })],
			[1.5, () => ({ kind: "call" })],
		];
		let roll = rand() * options.reduce((sum, [weight]) => sum + weight, 0);
		for (const [weight, make] of options) {
			roll -= weight;
			if (roll >= 0 || weight === 0) continue;
			const step = make();
			if (step !== undefined) steps.push(step);
			break;
		}
	}
	return { ...spec, steps };
}

/** The smallest case found that fails in the same category, by dropping steps, members, versions and flags. */
async function shrink(spec: Case, failure: Failure, seed: number): Promise<{ spec: Case; failure: Failure }> {
	let best = { spec, failure };
	const attempt = async (candidate: Case | undefined): Promise<boolean> => {
		if (candidate === undefined) return false;
		const found = await run(candidate, seed);
		if (found === undefined || found.category !== best.failure.category) return false;
		best = { spec: candidate, failure: found };
		return true;
	};
	for (let progress = true; progress; ) {
		progress = false;
		if (best.failure.step >= 0 && best.spec.steps.length > best.failure.step + 1)
			progress =
				(await attempt({ ...best.spec, steps: best.spec.steps.slice(0, best.failure.step + 1) })) || progress;
		for (let index = best.spec.steps.length - 1; index >= 0; index--) {
			if (index < best.spec.steps.length) progress = (await attempt(withoutStep(best.spec, index))) || progress;
		}
		for (const { name } of best.spec.pool) progress = (await attempt(withoutMember(best.spec, name))) || progress;
		for (let version = best.spec.versions.length; version >= 2; version--) {
			if (version <= best.spec.versions.length)
				progress = (await attempt(withoutVersion(best.spec, version))) || progress;
		}
		if (best.spec.flags.length > 1)
			progress = (await attempt({ ...best.spec, flags: best.spec.flags.slice(0, -1) })) || progress;
	}
	return { spec: tidy(best.spec), failure: best.failure };
}

/** `spec` with only the accepted versions and choices its providers can use (what shrinking leaves over). */
function tidy(spec: Case): Case {
	const steps = spec.steps.map((step): Step => {
		if (step.kind !== "serve") return step;
		const versions = step.accepts.versions.filter((version) => version < step.version);
		const choices: Record<string, "refuse" | "call"> = {};
		for (const [key, choice] of Object.entries(step.accepts.choices)) {
			const [version, member] = key.split(":") as [string, string];
			if (!versions.includes(Number(version)) || !spec.pool.some(({ name }) => name === member)) continue;
			const need = needOf(spec, Number(version), step.version, member).kind;
			const fits =
				choice === "call" ? need === "method-changed" : need.endsWith("removed") || need === "event-changed";
			if (fits) choices[key] = choice;
		}
		return { ...step, accepts: { versions, choices } };
	});
	return { ...spec, steps };
}

/** `spec` without step `index`; a hold's consumer goes with all its steps. */
function withoutStep(spec: Case, index: number): Case {
	const step = spec.steps[index]!;
	if (step.kind === "hold")
		return {
			...spec,
			steps: spec.steps.filter(
				(other) => !((other.kind === "hold" || other.kind === "release") && other.id === step.id),
			),
		};
	return { ...spec, steps: spec.steps.filter((_, other) => other !== index) };
}

/** `spec` without member `name`: its edits, grants and value steps. */
function withoutMember(spec: Case, name: string): Case {
	const steps = spec.steps.flatMap((step): Step[] => {
		if (step.kind === "value") return step.member === name ? [] : [step];
		if (step.kind === "decide" && step.decision.kind === "allow")
			return [{ ...step, decision: { kind: "allow", granted: step.decision.granted.filter((n) => n !== name) } }];
		return [step];
	});
	return {
		pool: spec.pool.filter((member) => member.name !== name),
		flags: spec.flags,
		versions: spec.versions.map((edits) => edits.filter(({ member }) => member !== name)),
		steps,
	};
}

/** `spec` without version `version` (2 or later): its edits merged into nothing, later versions renumbered. */
function withoutVersion(spec: Case, version: number): Case | undefined {
	const renumber = (v: number) => (v >= version ? v - 1 : v);
	const versions = spec.versions.filter((_, index) => index !== version - 1);
	const steps = spec.steps.map((step): Step => {
		if (step.kind === "hold") return { ...step, version: renumber(step.version) };
		if (step.kind !== "serve") return step;
		const choices: Record<string, "refuse" | "call"> = {};
		for (const [key, choice] of Object.entries(step.accepts.choices)) {
			const [v, member] = key.split(":");
			if (Number(v) !== version) choices[`${renumber(Number(v))}:${member}`] = choice;
		}
		const accepted = step.accepts.versions.filter((v) => v !== version).map(renumber);
		return { ...step, version: renumber(step.version), accepts: { versions: accepted, choices } };
	});
	// The edits of a dropped version must still apply to the versions after it: only drop one whose later edits fit.
	const candidate = { ...spec, versions, steps };
	try {
		contractsOf(candidate, "test.grantable-model.check");
	} catch {
		return undefined;
	}
	return candidate;
}

/** A case as a readable trace. */
function describeCase(spec: Case): string {
	const shape = (kind: Kind, { a, r }: Shape) =>
		kind === "method" ? `(${SCHEMA_NAMES[a]}) => ${SCHEMA_NAMES[r]}` : SCHEMA_NAMES[a];
	const lines = [
		`members: ${spec.pool.map(({ name, kind, grantable: g }) => `${name} ${g ? "grantable " : ""}${kind}`).join(", ")}; flags ${spec.flags.join(", ")}`,
	];
	for (const [index, edits] of spec.versions.entries()) {
		const text = edits.map((edit) => {
			const { kind } = poolOf(spec, edit.member);
			if (edit.op === "remove") return `-${edit.member}`;
			const sides = edit.op === "change" && kind === "method" ? ` [${edit.sides.join("")}]` : "";
			return `${edit.op === "add" ? "+" : "~"}${edit.member}: ${shape(kind, edit.shape)}${sides}`;
		});
		lines.push(`v${index + 1}: ${text.join("; ")}`);
	}
	for (const [index, step] of spec.steps.entries()) lines.push(`${index}. ${describeStep(step)}`);
	return lines.join("\n");
}

const SCHEMA_NAMES = ["str", "{v}", "[str]"];

function describeStep(step: Step): string {
	switch (step.kind) {
		case "serve": {
			const choices = Object.entries(step.accepts.choices).map(([key, choice]) => `${key} ${choice}`);
			const slow = step.slow === true ? ", slow to open" : "";
			return `serve v${step.version}${slow}, accepting [${step.accepts.versions}]${choices.length > 0 ? ` (${choices.join(", ")})` : ""}`;
		}
		case "hold":
			return `hold c${step.id}: v${step.version} ${step.at === "local" ? "on the server" : "over the link"}`;
		case "release":
			return `release c${step.id}`;
		case "decide":
			return `${step.who === "server" ? "server-host holders" : "link holders"}: ${JSON.stringify(step.decision)}`;
		case "value":
			return `${step.member} := ${step.value}`;
		default:
			return step.kind;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The tests.

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const ONE_SEED = process.env.GRANTABLE_SEED;
const FIRST = ONE_SEED === undefined ? env("GRANTABLE_FIRST_SEED", 1) : Number(ONE_SEED);
const SEEDS = ONE_SEED === undefined ? env("GRANTABLE_SEEDS", 25) : 1;
const STEPS = env("GRANTABLE_STEPS", 30);

/**
 * Findings not fixed yet, by the name of their case below (expected to fail until the fix lands, then removed), and
 * the default seeds that fail only because of them (skipped until then).
 */
const OPEN: Readonly<Record<string, string>> = {
	"a denied reference waits once its version is not served (same host)": "F3",
	"a denied reference waits once its version is not served (over a link)": "F3",
	"a reference refused a granted member binds once it is not granted (same host)": "F5",
	"a reference refused a granted member binds once it is not granted (over a link)": "F5",
	"a reference refused a member shows a later denial": "F5b",
	"a reference refused a member takes no value at a restart": "F7",
};
const OPEN_SEEDS: Readonly<Record<number, string>> = { 2: "F3", 7: "F3", 13: "F3", 14: "F3", 21: "F3", 24: "F3" };

describe("grantable members across versions and lifecycles, against the model", () => {
	it(`hold for seeds ${FIRST} to ${FIRST + SEEDS - 1} (${STEPS} steps each)`, async () => {
		const found: string[] = [];
		const categories = new Set<string>();
		for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
			if (OPEN_SEEDS[seed] !== undefined) continue;
			const spec = generate(seed, STEPS);
			const failure = await run(spec, seed);
			if (failure === undefined || categories.has(failure.category)) {
				if (failure !== undefined) found.push(`seed ${seed}: ${failure.category} (shrunk under an earlier seed)`);
				continue;
			}
			categories.add(failure.category);
			const small = await shrink(spec, failure, seed);
			const text = `seed ${seed}, step ${small.failure.step}, ${small.failure.category}:\n${small.failure.message}\n${describeCase(small.spec)}\n${JSON.stringify(small.spec)}`;
			console.log(text);
			found.push(text);
		}
		expect(found).toEqual([]);
	}, 600_000);
});

/** A case by hand: a history from `versions` (members named by kind letter, `g` suffix: grantable), and steps. */
function scenario(pool: string, versions: readonly (readonly Edit[])[], steps: readonly Step[]): Case {
	const members = pool
		.split(" ")
		.filter((name) => name !== "")
		.map(
			(name): PoolMember => ({
				name: name.replace(/g$/, ""),
				kind: name[0] === "s" ? "state" : name[0] === "e" ? "event" : "method",
				grantable: name.endsWith("g"),
			}),
		);
	return { pool: members, flags: ["f0"], versions, steps };
}

const S0: Shape = { a: 0, r: 0 };
const add = (member: string, shape = S0): Edit => ({ op: "add", member, shape });
const remove = (member: string): Edit => ({ op: "remove", member });
const change = (member: string, shape: Shape = { a: 1, r: 0 }): Edit => ({ op: "change", member, shape, sides: ["a"] });
const serve = (
	version: number,
	versions: number[] = [],
	choices: Record<string, "refuse" | "call"> = {},
	slow = false,
): Step => ({ kind: "serve", version, accepts: { versions, choices }, slow });
const hold = (id: number, version: number, at: "local" | "link"): Step => ({ kind: "hold", id, version, at });
const decide = (who: Who, decision: Decision): Step => ({ kind: "decide", who, decision });
const allowing = (...granted: string[]): Decision => ({ kind: "allow", granted });
const denying: Decision = { kind: "deny", reason: "no access" };

/** The minimal cases the seeds found, each a regression test. */
const REGRESSIONS: Readonly<Record<string, Case>> = {
	// Sol 1: a first denial clears the placeholders a reference has before its first binding.
	"a first denial removes the grantable members (over a link)": scenario(
		"m0g",
		[[add("m0")]],
		[hold(1, 1, "link"), decide("owner", denying), serve(1)],
	),
	"a first denial removes the grantable members (same host)": scenario(
		"e0g",
		[[add("e0")]],
		[serve(1), decide("server", denying), hold(1, 1, "local")],
	),
	// Sol 2: a same-host older binding is granted only the names its version has.
	"a same-host older binding is granted only its version's names": scenario(
		"m0g",
		[[], [add("m0")]],
		[decide("server", allowing("m0")), serve(2, [1]), hold(1, 1, "local")],
	),
	// Sol 3: a reference keeps its last grant while a replacement provider loads.
	"a reference keeps its grant while a replacement loads": scenario(
		"s0g",
		[[add("s0")]],
		[
			serve(1),
			decide("server", allowing("s0")),
			hold(1, 1, "local"),
			{ kind: "remove" },
			decide("server", allowing()),
			serve(1, [], {}, true),
		],
	),
	// A denied reference whose provider moves to a version that does not bind it waits, as a fresh hold of it does.
	"a denied reference waits once its version is not served (same host)": scenario(
		"",
		[[], []],
		[serve(2, [1]), decide("server", denying), hold(1, 2, "local"), serve(1)],
	),
	"a denied reference waits once its version is not served (over a link)": scenario(
		"",
		[[], []],
		[serve(2, [1]), decide("owner", denying), hold(1, 2, "link"), serve(1)],
	),
	// A reference that never bound has no grant: not the shared hold's it joins while the link is down.
	"a reference joining a hold while its link is down has no grant": scenario(
		"s0g",
		[[add("s0")]],
		[serve(1), decide("owner", allowing("s0")), hold(1, 1, "link"), { kind: "drop" }, hold(2, 1, "link")],
	),
	// A reference that never bound has no grant: not the object's when its version is refused a member.
	"a reference refused a member has no grant (same host)": scenario(
		"e0 s1g",
		[[add("e0"), add("s1")], [change("e0")]],
		[decide("server", allowing("s1")), serve(2, [1], { "1:e0": "refuse" }), hold(2, 2, "local"), hold(1, 1, "local")],
	),
	// A refusal by a granted member follows the grant: without it the reference binds.
	"a reference refused a granted member binds once it is not granted (same host)": scenario(
		"e0g",
		[[add("e0")], [change("e0")]],
		[
			decide("server", allowing("e0")),
			serve(2, [1], { "1:e0": "refuse" }),
			hold(1, 1, "local"),
			decide("server", allowing()),
		],
	),
	"a reference refused a granted member binds once it is not granted (over a link)": scenario(
		"e0g",
		[[add("e0")], [change("e0")]],
		[
			decide("owner", allowing("e0")),
			serve(2, [1], { "1:e0": "refuse" }),
			hold(1, 1, "link"),
			decide("owner", allowing()),
		],
	),
	// A reference waiting on a refused member shows a later denial, as a fresh hold of it does.
	"a reference refused a member shows a later denial": scenario(
		"e0",
		[[add("e0")], [change("e0")]],
		[hold(1, 1, "link"), serve(2, [1], { "1:e0": "refuse" }), decide("owner", denying)],
	),
	// A reference waiting for its provider keeps its last grant when the provider comes back refusing it a member.
	"a removed provider's reference keeps its grant when the next one refuses it a member": scenario(
		"s0",
		[[add("s0")], [remove("s0")]],
		[
			decide("server", allowing("f0")),
			hold(1, 1, "local"),
			serve(1),
			{ kind: "remove" },
			serve(2, [1], { "1:s0": "refuse" }),
		],
	),
	// A reference that was never live keeps no value: none taken from an instance it never bound to.
	"a reference refused a member takes no value at a restart": scenario(
		"s0 s1",
		[
			[add("s0"), add("s1")],
			[remove("s0"), remove("s1")],
		],
		[
			hold(2, 2, "local"),
			serve(2, [1], { "1:s1": "refuse" }),
			hold(1, 1, "local"),
			serve(2, [1], { "1:s1": "refuse" }),
		],
	),
	// A reference that never bound has no grant, also after a restart of the provider that refuses it a member.
	"a reference refused a granted member has no grant after a restart (same host)": scenario(
		"e0g",
		[[add("e0")], [change("e0")]],
		[
			hold(1, 1, "local"),
			decide("server", allowing("e0", "f0")),
			serve(2, [1], { "1:e0": "refuse" }),
			serve(2, [1], { "1:e0": "refuse" }),
		],
	),
	"a reference refused a granted member has no grant after a restart (over a link)": scenario(
		"e0g",
		[[add("e0")], [change("e0")]],
		[
			hold(1, 1, "link"),
			decide("owner", allowing("e0", "f0")),
			serve(2, [1], { "1:e0": "refuse" }),
			serve(2, [1], { "1:e0": "refuse" }),
		],
	),
};

describe("grantable members: minimal cases the model found", () => {
	for (const [name, spec] of Object.entries(REGRESSIONS)) {
		(OPEN[name] === undefined ? it : it.fails)(name, async () => {
			const failure = await run(spec);
			expect(failure && `${failure.category}: ${failure.message}\n${describeCase(spec)}`).toBeUndefined();
		});
	}
});

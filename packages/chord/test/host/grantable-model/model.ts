// The grantable model's spec: what each consumer's reference shows after a step, written from slice 15 §1 and design
// §6, §7, §27, kept short and readable.

import type { MessageData } from "../../../src/data/index.ts";
import type { JsonValue } from "../../../src/json.ts";
import {
	type AcceptsSpec,
	type Case,
	type Decision,
	encode,
	isGrantableName,
	KEYS,
	keyedMembersAt,
	keyedNeed,
	membersAt,
	needOf,
	poolOf,
	type Who,
} from "./case.ts";

/** What the world is after the steps so far. */
export type World = {
	provider: { readonly version: number; readonly accepts: AcceptsSpec } | undefined;
	readonly decisions: Record<Who, Decision>;
	linkUp: boolean;
	readonly base: Record<string, string>;
	/** The principals whose object failed live (`broken`): until a retry, a reload or another decision (§6). */
	readonly broken: Set<Who>;
	/** The local keyed contract's provider and documents (`keyed` in the case). */
	keyed: KeyedWorld;
};

/** What a reference keeps between bindings: its last binding's grant and values; placeholders until first live. */
export type Memory = {
	readonly placeholders: boolean;
	readonly granted: readonly string[];
	readonly values: ReadonlyMap<string, JsonValue> | undefined;
};

export type Status = "live" | "loading" | "waiting" | "denied" | "broken";

/** What a read or a call gives: a value, or a throw with an error code (`*` in the model: any code). */
export type Outcome =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "throws"; readonly code: string };

/** A member as a reference shows it: missing, there (method, event), or a state member's read. */
export type MemberView = { readonly kind: "absent" } | { readonly kind: "present" } | Outcome;

export const ABSENT: MemberView = { kind: "absent" };
export const PRESENT: MemberView = { kind: "present" };

export type View = {
	readonly status: Status;
	readonly granted: readonly string[];
	readonly members: Readonly<Record<string, MemberView>>;
	/** A denial's error: its message (the reason) and its `details.message`. */
	readonly denial?: { readonly reason: string; readonly message: MessageData | null };
};

export type Consumer = { readonly id: number; readonly version: number; readonly at: "local" | "link" };

/** What the binding of `consumer` is in `world`, the link aside. */
export type Binding =
	| { readonly kind: "waiting" }
	| { readonly kind: "broken" }
	| { readonly kind: "denied"; readonly reason: string; readonly message: MessageData | null }
	| {
			readonly kind: "bound";
			/** What the consumer's version knows of the object's grant. */
			readonly granted: ReadonlySet<string>;
			readonly values: ReadonlyMap<string, JsonValue>;
	  };

/** The model: a consumer's binding. */
export function bindingOf(spec: Case, world: World, consumer: Consumer): Binding {
	const provider = world.provider;
	// Not served, a newer consumer, or an older version not accepted: waiting unbound (§7, §27).
	if (provider === undefined || consumer.version > provider.version) return { kind: "waiting" };
	if (consumer.version < provider.version && !provider.accepts.versions.includes(consumer.version))
		return { kind: "waiting" };
	// A provider refusing a member of the version refuses the version, whatever the grant: it waits for a publication.
	if (refusesVersion(spec, provider, consumer.version)) return { kind: "waiting" };
	const decision = world.decisions[whoOf(consumer)];
	if (decision.kind === "deny") return { kind: "denied", reason: decision.reason, message: decision.message ?? null };
	const now = membersAt(spec, provider.version);
	const old = membersAt(spec, consumer.version);
	// The provider's admission grants what its version has (it filters); the consumer's version knows its own names.
	const objectGranted = new Set(decision.granted.filter((name) => isGrantableName(spec, name, now)));
	const granted = new Set([...objectGranted].filter((name) => isGrantableName(spec, name, old)));
	const visible = (member: string) => !poolOf(spec, member).grantable || granted.has(member);
	// Its object failed live: its holders show the failure with their last values (§6, §7).
	if (world.broken.has(whoOf(consumer))) return { kind: "broken" };
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
export function expected(spec: Case, world: World, consumer: Consumer, memory: Memory): { view: View; memory: Memory } {
	// A link drop: loading, the last binding's grant and values (§7).
	if (consumer.at === "link" && !world.linkUp) return { view: remembered(spec, consumer, memory, "loading"), memory };
	const binding = bindingOf(spec, world, consumer);
	switch (binding.kind) {
		case "waiting":
		case "broken":
			return { view: remembered(spec, consumer, memory, binding.kind), memory };
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
export function remembered(spec: Case, consumer: Consumer, memory: Memory, status: Status): View {
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
export function expectedCall(
	spec: Case,
	world: World,
	consumer: Consumer,
	view: View,
	member: string,
	x: string,
): Outcome {
	if (view.status === "denied") return thrown("forbidden");
	if (view.status === "waiting" || view.status === "broken") return thrown("*");
	if (!view.granted.includes(member) && poolOf(spec, member).grantable) return thrown("forbidden");
	const provider = world.provider!;
	const shape = membersAt(spec, consumer.version).get(member)!;
	const need = needOf(spec, consumer.version, provider.version, member);
	const choice = provider.accepts.choices[`${consumer.version}:${member}`];
	if (need.kind === "method-removed" && choice === "refuse") return thrown("contract_mismatch");
	const replaced = need.kind === "method-removed" || (need.kind === "method-changed" && choice === "call");
	return { kind: "value", value: encode(shape.r, `${replaced ? "c" : "r"}:${x}`) };
}

/** Whether `provider` refuses a state or event member of `version` (§27), which refuses the version. */
export function refusesVersion(spec: Case, provider: NonNullable<World["provider"]>, version: number): boolean {
	return [...membersAt(spec, version).keys()].some((member) => {
		const need = needOf(spec, version, provider.version, member).kind;
		const refused = provider.accepts.choices[`${version}:${member}`] === "refuse";
		return refused && (need === "state-removed" || need === "event-changed");
	});
}

/**
 * The model: whether the provider's object for `who` lives: while a holder of a version it binds holds it (bound,
 * denied or failed), and never with none (§6: an object ends with its last reference, `linger` 0).
 */
export function objectLives(spec: Case, world: World, consumers: Iterable<Consumer>, who: Who): boolean {
	const provider = world.provider;
	if (provider === undefined) return false;
	for (const consumer of consumers) {
		if (whoOf(consumer) !== who || (consumer.at === "link" && !world.linkUp)) continue;
		const served = consumer.version === provider.version || provider.accepts.versions.includes(consumer.version);
		if (served && !refusesVersion(spec, provider, consumer.version)) return true;
	}
	return false;
}

export function thrown(code: string): Outcome {
	return { kind: "throws", code };
}

/** The model: what an emit of every built event member gives a consumer (member, value), in member order. */
export function expectedEvents(spec: Case, world: World, consumer: Consumer, view: View, emitted: Emitted): Received[] {
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

/** The keyed contract's provider and its documents (by member, by key): what consumers of it see. */
export type KeyedWorld = {
	provider: { readonly version: number; readonly accepts: AcceptsSpec } | undefined;
	docs: Record<string, Record<string, string>>;
};

/**
 * The model of the keyed contract: what a consumer of `version` reads, or `undefined` while it waits unbound (not
 * served, not accepted, or a member refused: a removed keyed member is always refused). Values by plain member and by
 * `member/key` for keyed ones (§27: mapped per key; a changed member's mapping marks the value with the version).
 */
export function keyedBinding(spec: Case, world: World, version: number): ReadonlyMap<string, JsonValue> | undefined {
	const provider = world.keyed.provider;
	if (provider === undefined || version > provider.version) return undefined;
	if (version < provider.version && !provider.accepts.versions.includes(version)) return undefined;
	const values = new Map<string, JsonValue>();
	for (const member of keyedMembersAt(spec, version)) {
		const need = keyedNeed(spec, version, provider.version, member);
		const refused = provider.accepts.choices[`${version}:${member}`] === "refuse";
		const keyed = member.startsWith("k");
		if ((need === "removed" && (keyed || refused)) || (need === "changed" && keyed && refused)) return undefined;
		const mark = need === "changed" ? `@${version}` : "";
		if (!keyed) values.set(member, need === "removed" ? `rm@${version}` : `${member}${mark}`);
		else
			for (const key of KEYS)
				values.set(`${member}/${key}`, { n: `${world.keyed.docs[member]?.[key] ?? ""}${mark}` });
	}
	return values;
}

/** An event a reference received: its member and value. */
export type Received = { readonly member: string; readonly value: JsonValue };

/** Per principal kind, the value emitted per member. */
export type Emitted = Map<Who, Map<string, string>>;

export function whoOf(consumer: Consumer): Who {
	return consumer.at === "local" ? "server" : "owner";
}

export function baseOf(world: World, member: string): string {
	return world.base[member] ?? `${member}.0`;
}

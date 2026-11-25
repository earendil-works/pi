// The grantable model's cases from a seed: generating them, shrinking a failing one, and printing it.

import {
	type AcceptsSpec,
	type Case,
	type Decision,
	type Edit,
	KEYS,
	type KeyedCase,
	type Kind,
	keyedMembersAt,
	keyedNeed,
	membersAt,
	needOf,
	type PoolMember,
	poolOf,
	type Shape,
	type Step,
	type Who,
} from "./case.ts";
import { contractsOf } from "./plugins.ts";
import { type Failure, run } from "./runner.ts";

/** A seeded generator of numbers in [0, 1) (mulberry32). */
export function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** How large generated cases get (the env's `GRANTABLE_MAX_*` for a long hunt). */
export type Limits = {
	readonly versions: number;
	readonly members: number;
	readonly edits: number;
	readonly holds: number;
};

/** The case of `seed`: a history of up to `limits.versions` versions over 3 to `limits.members` members, `count` steps. */
export function generate(seed: number, count: number, limits: Limits): Case {
	const rand = random(seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
	const chance = (p: number) => rand() < p;
	const upTo = (n: number) => 1 + Math.floor(rand() * n);
	const shape = (): Shape => ({ a: pick([0, 1, 2]), r: pick([0, 1, 2]) });
	const pool: PoolMember[] = Array.from({ length: 2 + upTo(Math.max(1, limits.members - 2)) }, (_, index) => {
		const kind = pick<Kind>(["state", "event", "method"]);
		return { name: `${kind[0]}${index}`, kind, grantable: chance(0.5) };
	});
	const flags = chance(0.5) ? ["f0"] : ["f0", "f1"];
	const versions: Edit[][] = [
		pool.filter(() => chance(0.7)).map(({ name }) => ({ op: "add", member: name, shape: shape() })),
	];
	const total = upTo(limits.versions);
	const empty: KeyedCase = { members: [], versions: [] };
	while (versions.length < total) {
		const present = membersAt({ pool, flags, versions, keyed: empty, steps: [] }, versions.length);
		const edits: Edit[] = [];
		for (let edit = 0; edit < upTo(limits.edits); edit++) {
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
	const keyedCase = generateKeyed(rand, limits);
	const spec: Case = { pool, flags, versions, keyed: keyedCase, steps: [] };
	const serve = (): Step => {
		// The newest version half the time: older consumers then meet their mappings.
		const version = chance(0.5) ? total : upTo(total);
		const accepted = Array.from({ length: version - 1 }, (_, index) => index + 1).filter(() => chance(0.8));
		const choices: Record<string, "refuse" | "call"> = {};
		for (const old of accepted) {
			for (const [member] of membersAt(spec, old)) {
				const need = needOf(spec, old, version, member).kind;
				if (need === "state-removed" || need === "event-changed" || need === "method-removed") {
					if (chance(0.2)) choices[`${old}:${member}`] = "refuse";
				} else if (need === "method-changed" && chance(0.3)) choices[`${old}:${member}`] = "call";
			}
		}
		return {
			kind: "serve",
			version,
			accepts: { versions: accepted, choices },
			slow: chance(0.3),
			busy: chance(0.25),
		};
	};
	const keyedTotal = keyedCase.versions.length;
	const keyedServe = (): Step => {
		const version = chance(0.5) ? keyedTotal : upTo(keyedTotal);
		const accepted = Array.from({ length: version - 1 }, (_, index) => index + 1).filter(() => chance(0.8));
		const choices: Record<string, "refuse" | "call"> = {};
		for (const old of accepted) {
			for (const member of keyedMembersAt(spec, old)) {
				const need = keyedNeed(spec, old, version, member);
				const refusable = member.startsWith("k") ? need === "changed" : need === "removed";
				if (refusable && chance(0.25)) choices[`${old}:${member}`] = "refuse";
			}
		}
		return { kind: "kserve", version, accepts: { versions: accepted, choices } };
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
	let keyedServed = false;
	let linkUp = true;
	let nextId = 1;
	const alive: number[] = [];
	const keyedAlive: number[] = [];
	const stateMembers = pool.filter(({ kind }) => kind === "state").map(({ name }) => name);
	const keyedMembers = keyedCase.members.filter((member) => member.startsWith("k"));
	while (steps.length < count) {
		const options: [number, () => Step][] = [
			[
				alive.length < limits.holds ? 3 : 0,
				() => {
					const id = nextId++;
					alive.push(id);
					return { kind: "hold", id, version: upTo(total), at: pick(["local", "link"] as const) };
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
			[0.5, () => ({ kind: "break", who: pick<Who>(["server", "owner"]) })],
			[alive.length > 0 ? 0.7 : 0, () => ({ kind: "retry", id: pick(alive) })],
			[
				1,
				() => {
					keyedServed = true;
					return keyedServe();
				},
			],
			[
				keyedServed ? 0.3 : 0,
				() => {
					keyedServed = false;
					return { kind: "kremove" };
				},
			],
			[
				keyedAlive.length < 3 ? 1 : 0,
				() => {
					const id = nextId++;
					keyedAlive.push(id);
					return { kind: "khold", id, version: upTo(keyedTotal) };
				},
			],
			[
				keyedAlive.length > 0 ? 0.4 : 0,
				() => ({ kind: "krelease", id: keyedAlive.splice(Math.floor(rand() * keyedAlive.length), 1)[0]! }),
			],
			[
				keyedMembers.length > 0 ? 1.5 : 0,
				() => ({ kind: "kput", member: pick(keyedMembers), key: pick(KEYS), value: `n${steps.length}` }),
			],
		];
		let roll = rand() * options.reduce((sum, [weight]) => sum + weight, 0);
		for (const [weight, make] of options) {
			roll -= weight;
			if (roll >= 0 || weight === 0) continue;
			steps.push(make());
			break;
		}
	}
	return { ...spec, steps };
}

/** The keyed contract's history: one or two keyed members and plain ones, up to `limits.versions` versions. */
export function generateKeyed(rand: () => number, limits: Limits): KeyedCase {
	const members = ["k0", "k1", "t0", "t1"].filter((_, index) => index === 0 || rand() < 0.6);
	const versions: Edit[][] = [
		members
			.filter((member) => member === "k0" || rand() < 0.7)
			.map((member) => ({ op: "add", member, shape: { a: 0, r: 0 } })),
	];
	const total = 1 + Math.floor(rand() * limits.versions);
	while (versions.length < total) {
		const present = new Set<string>();
		for (const edit of versions.flat()) {
			if (edit.op === "remove") present.delete(edit.member);
			else present.add(edit.member);
		}
		const member = members[Math.floor(rand() * members.length)]!;
		const op = !present.has(member) ? "add" : rand() < 0.3 ? "remove" : "change";
		versions.push([
			op === "remove"
				? { op, member }
				: op === "add"
					? { op, member, shape: { a: 0, r: 0 } }
					: { op, member, shape: { a: 0, r: 0 }, sides: ["a"] },
		]);
	}
	return { members, versions };
}

/** The smallest case found that fails in the same category, by dropping steps, members, versions and flags. */
export async function shrink(spec: Case, failure: Failure, seed: number): Promise<{ spec: Case; failure: Failure }> {
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
		for (const name of [...best.spec.pool.map(({ name }) => name), ...best.spec.keyed.members])
			progress = (await attempt(withoutMember(best.spec, name))) || progress;
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
export function tidy(spec: Case): Case {
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
export function withoutStep(spec: Case, index: number): Case {
	const step = spec.steps[index]!;
	if (step.kind === "hold" || step.kind === "khold")
		return { ...spec, steps: spec.steps.filter((other) => idOf(other) !== step.id) };
	return { ...spec, steps: spec.steps.filter((_, other) => other !== index) };
}

/** The consumer a step names, if any. */
export function idOf(step: Step): number | undefined {
	switch (step.kind) {
		case "hold":
		case "release":
		case "retry":
		case "khold":
		case "krelease":
			return step.id;
		default:
			return undefined;
	}
}

/** `spec` without member `name`: its edits, grants and value steps. */
export function withoutMember(spec: Case, name: string): Case {
	const steps = spec.steps.flatMap((step): Step[] => {
		if (step.kind === "value" || step.kind === "kput") return step.member === name ? [] : [step];
		if (step.kind === "decide" && step.decision.kind === "allow")
			return [{ ...step, decision: { kind: "allow", granted: step.decision.granted.filter((n) => n !== name) } }];
		return [step];
	});
	return {
		pool: spec.pool.filter((member) => member.name !== name),
		flags: spec.flags,
		versions: spec.versions.map((edits) => edits.filter(({ member }) => member !== name)),
		keyed: {
			members: spec.keyed.members.filter((member) => member !== name),
			versions: spec.keyed.versions.map((edits) => edits.filter(({ member }) => member !== name)),
		},
		steps,
	};
}

/** `spec` without version `version` (2 or later): its edits merged into nothing, later versions renumbered. */
export function withoutVersion(spec: Case, version: number): Case | undefined {
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
export function describeCase(spec: Case): string {
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
	if (spec.keyed.members.length > 0) {
		lines.push(`keyed contract: ${spec.keyed.members.join(", ")} (k: keyed, t: plain state)`);
		for (const [index, edits] of spec.keyed.versions.entries()) {
			const text = edits.map(({ op, member }) => `${op === "add" ? "+" : op === "remove" ? "-" : "~"}${member}`);
			lines.push(`  v${index + 1}: ${text.join("; ")}`);
		}
	}
	for (const [index, step] of spec.steps.entries()) lines.push(`${index}. ${describeStep(step)}`);
	return lines.join("\n");
}

export const SCHEMA_NAMES = ["str", "{v}", "[str]"];

export function describeStep(step: Step): string {
	const accepting = (accepts: AcceptsSpec) => {
		const choices = Object.entries(accepts.choices).map(([key, choice]) => `${key} ${choice}`);
		return `accepting [${accepts.versions}]${choices.length > 0 ? ` (${choices.join(", ")})` : ""}`;
	};
	switch (step.kind) {
		case "serve": {
			const slow = step.slow === true ? ", slow to open" : "";
			const busy = step.busy === true ? ", a call running on the old provider" : "";
			return `serve v${step.version}${slow}${busy}, ${accepting(step.accepts)}`;
		}
		case "kserve":
			return `serve the keyed contract v${step.version}, ${accepting(step.accepts)}`;
		case "khold":
			return `hold k${step.id}: keyed v${step.version} on the server`;
		case "krelease":
			return `release k${step.id}`;
		case "kput":
			return `put ${step.member}[${step.key}] = ${step.value}`;
		case "break":
			return `the ${step.who} principal's object fails live`;
		case "retry":
			return `retry c${step.id}`;
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

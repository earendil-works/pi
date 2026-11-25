// The grantable model's runner: runs a case against Chord and, after every step, compares each reference with the
// model and checks the invariants (state identity and notification, objects' lives, the unbound clock).

import { BACKGROUND_CONTEXT as ctx } from "../../../src/context/index.ts";
import type { Contract, EventMember } from "../../../src/contracts/index.ts";
import { ChordError, type MessageData } from "../../../src/data/index.ts";
import { createHost, type Host, type HostError, type RefState } from "../../../src/host/index.ts";
import { ChordObject } from "../../../src/host/object.ts";
import type { PluginFacet } from "../../../src/host/staging.ts";
import { UnboundClock } from "../../../src/host/unbound-clock.ts";
import type { JsonValue } from "../../../src/json.ts";
import { memoryLinkPair } from "../../../src/link/index.ts";
import type { NativeWatchHandle, WatchHandle } from "../../../src/watch.ts";
import { failLive, instancesOf, Server, type TestPrincipal, testCodec } from "../../support.ts";
import {
	type Case,
	type Decision,
	encode,
	KEYS,
	keyedMembersAt,
	membersAt,
	poolOf,
	type Step,
	type Who,
} from "./case.ts";
import {
	ABSENT,
	bindingOf,
	type Consumer,
	type Emitted,
	expected,
	expectedCall,
	expectedEvents,
	keyedBinding,
	type MemberView,
	type Memory,
	type Outcome,
	objectLives,
	PRESENT,
	type Received,
	type Status,
	thrown,
	type View,
	type World,
	whoOf,
} from "./model.ts";
import {
	Access,
	type Busy,
	contractsOf,
	keyedContractsOf,
	keyedPlugin,
	Pinned,
	providerPlugin,
	type Shared,
	Values,
	worldPlugin,
} from "./plugins.ts";

/** A reference of a dynamic contract version. */
export type DynRef = {
	readonly granted: ReadonlySet<string>;
	readonly state: { readonly value: RefState; watch(context: typeof ctx): Promise<NativeWatchHandle<RefState>> };
	retry(): void;
	release(): void;
	readonly [member: string]: unknown;
};

/**
 * What the runner follows of a reference's state, whatever its contract: its state watch's last value and this step's
 * frames, the state object last read (its identity), and the violations its watch found.
 */
export type Followed = {
	readonly label: string;
	readonly ref: DynRef;
	watched: RefState | undefined;
	frames: string[];
	read: { readonly state: RefState; readonly key: string } | undefined;
	readonly violations: string[];
};

/** A consumer of the grantable contract as the runner follows it. */
export type Held = Consumer &
	Followed & {
		memory: Memory;
		view: View;
		/** Every member object seen, by name: a member keeps its identity across bindings. */
		readonly handles: Map<string, unknown>;
		/** The event members subscribed to, by name. */
		readonly subscribed: Set<string>;
		readonly received: Received[];
		/** The grant it showed when last seen live (by its state watch or a check); empty after a denial. */
		lastGranted: readonly string[];
	};

/** A consumer of the keyed contract: its last bound values (watches keep them) and its key watches. */
export type KeyedHeld = Followed & {
	readonly id: number;
	readonly version: number;
	memory: ReadonlyMap<string, JsonValue> | undefined;
	bound: boolean;
	/** Its watches, by `member/key`, made once it was live. */
	readonly watches: Map<string, WatchHandle<JsonValue>>;
};

/** A failure: the step it happened at, its category (what shrinking keeps), and what was seen. */
export type Failure = { readonly step: number; readonly category: string; readonly message: string };

export const SETTLE_MIN = 12;
export const SETTLE_MAX = 600;

/** The provider's objects, to see a restart's open old attempt and to fail one live (test support's wrapping). */
export const objects = instancesOf(ChordObject, "hold");

/**
 * Every request waiting unbound on a host's clock, reported or not: Chord keeps no count, so the clock's `start` and
 * `stop` are wrapped (as `instancesOf` wraps methods). Cleared at each run: a closed host's clock stops nothing.
 */
export const unboundWaits = new Set<object>();
{
	const clock = UnboundClock.prototype;
	const { start, stop } = clock;
	clock.start = function (this: UnboundClock, request, waitingFor, error) {
		unboundWaits.add(request);
		start.call(this, request, waitingFor, error);
	};
	clock.stop = function (this: UnboundClock, request) {
		unboundWaits.delete(request);
		stop.call(this, request);
	};
}

/** Everything a run follows. */
export type Run = {
	readonly spec: Case;
	readonly world: World;
	readonly shared: Shared;
	readonly server: Host<TestPrincipal>;
	readonly client: Host<TestPrincipal>;
	readonly contracts: readonly Contract[];
	readonly keyedContracts: readonly Contract[];
	readonly consumers: Map<number, Held>;
	readonly keyedConsumers: Map<number, KeyedHeld>;
	/** The `Pinned` reader, when the keyed contract's v1 has a keyed member. */
	readonly pinned: { readonly ref: DynRef; memory: string | undefined } | undefined;
	readonly plugins: {
		world: PluginFacet<TestPrincipal>;
		provider?: PluginFacet<TestPrincipal>;
		keyed?: PluginFacet<TestPrincipal>;
	};
	link: { close(): void };
	emitted: Emitted;
	emits: number;
	readonly errors: string[];
};

/** Runs `spec`; the first failure, if any. */
export async function run(spec: Case, seed = 0): Promise<Failure | undefined> {
	let contracts: Contract[];
	let keyedContracts: Contract[];
	try {
		contracts = contractsOf(spec, `test.grantable-model.c${seed}`);
		keyedContracts = keyedContractsOf(spec, `test.grantable-model.k${seed}`);
	} catch (error) {
		return { step: -1, category: "declaration", message: String(error) };
	}
	unboundWaits.clear();
	objects.length = 0;
	const world: World = {
		provider: undefined,
		decisions: { server: { kind: "allow", granted: [] }, owner: { kind: "allow", granted: [] } },
		linkUp: true,
		base: {},
		broken: new Set(),
		keyed: { provider: undefined, docs: {} },
	};
	const shared: Shared = {
		world,
		factories: 0,
		live: new Map(),
		selves: new Map(),
		probes: new Map(),
		busy: undefined,
		documents: new Map(),
	};
	const errors: string[] = [];
	const report = (where: string) => (error: HostError) =>
		errors.push(`${where}: ${JSON.stringify(error)}`.slice(0, 300));
	const server = createHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		onError: report("server"),
	});
	const client = createHost<TestPrincipal>({ onError: report("client") });
	const plugins = { world: worldPlugin(spec, keyedContracts, shared) };
	await server.load([plugins.world], ctx);
	await client.load([], ctx);
	const pinned = [...keyedMembersAt(spec, 1)].some((member) => member.startsWith("k"))
		? { ref: server.hold(Pinned, {}, ctx) as unknown as DynRef, memory: undefined }
		: undefined;
	const state: Run = {
		spec,
		world,
		shared,
		server,
		client,
		contracts,
		keyedContracts,
		consumers: new Map(),
		keyedConsumers: new Map(),
		pinned,
		plugins,
		link: connect(server, client),
		emitted: new Map(),
		emits: 0,
		errors,
	};
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
			state.emitted = new Map();
			for (const followed of everyFollowed(state)) followed.frames = [];
			const outcome = await perform(state, step, index);
			if (outcome !== undefined) return fail(index, outcome.category, outcome.message);
			const mismatch = await settle(() => compareAll(state));
			if (mismatch !== undefined) return fail(index, mismatch.category, mismatch.message);
			for (const held of state.consumers.values()) {
				await subscribe(spec, held);
				held.received.length = 0;
			}
			for (const held of state.keyedConsumers.values()) await watchKeys(spec, held);
			if (equalDecision && shared.factories !== factoriesBefore)
				return fail(index, "rebuild", "an equal decision ran the factory again");
		}
		return undefined;
	} catch (error) {
		return fail(-1, "crash", String((error as Error)?.stack ?? error));
	} finally {
		for (const held of everyFollowed(state)) held.ref.release();
		pinned?.ref.release();
		shared.busy?.gate.resolve();
		await client.close(ctx);
		await server.close(ctx);
	}
}

/** Every reference the run follows. */
export function everyFollowed(state: Run): Followed[] {
	return [...state.consumers.values(), ...state.keyedConsumers.values()];
}

/** Performs `step` and moves the model on: the world, then each consumer's expected view. */
export async function perform(state: Run, step: Step, index: number): Promise<Omit<Failure, "step"> | undefined> {
	const { spec, world, shared, server, client } = state;
	switch (step.kind) {
		case "serve": {
			const plugin = providerPlugin(spec, state.contracts, step.version, step.accepts, step.slow === true, shared);
			const before = { ...world, provider: world.provider };
			world.provider = { version: step.version, accepts: step.accepts };
			// A reload retries a failed object (§6 triggers).
			world.broken.clear();
			if (step.busy === true) {
				const found = await busyReload(state, plugin, before, index);
				if (found !== undefined) return found;
				break;
			}
			state.plugins.provider = plugin;
			await reload(state);
			break;
		}
		case "remove":
			world.provider = undefined;
			world.broken.clear();
			state.plugins.provider = undefined;
			await reload(state);
			break;
		case "kserve":
			world.keyed.provider = { version: step.version, accepts: step.accepts };
			state.plugins.keyed = keyedPlugin(spec, state.keyedContracts, step.version, step.accepts, shared);
			await reload(state);
			break;
		case "kremove":
			// A removed type's object ends: a later one starts its in-memory documents over (§7).
			world.keyed = { provider: undefined, docs: {} };
			state.plugins.keyed = undefined;
			await reload(state);
			break;
		case "hold": {
			const host = step.at === "local" ? server : client;
			const ref = host.hold(state.contracts[step.version - 1]!, {}, ctx) as unknown as DynRef;
			const held: Held = {
				id: step.id,
				version: step.version,
				at: step.at,
				...followed(`c${step.id} (v${step.version} ${step.at})`, ref),
				memory: { placeholders: true, granted: [], values: undefined },
				view: { status: "loading", granted: [], members: {} },
				handles: new Map(),
				subscribed: new Set(),
				received: [],
				lastGranted: [],
			};
			state.consumers.set(step.id, held);
			watchState(held, (call) => grantInvariant(spec, held, call));
			break;
		}
		case "khold": {
			const ref = server.hold(state.keyedContracts[step.version - 1]!, {}, ctx) as unknown as DynRef;
			const held: KeyedHeld = {
				id: step.id,
				version: step.version,
				...followed(`k${step.id} (v${step.version})`, ref),
				memory: undefined,
				bound: false,
				watches: new Map(),
			};
			state.keyedConsumers.set(step.id, held);
			watchState(held, () => {});
			break;
		}
		case "release":
			state.consumers.get(step.id)?.ref.release();
			state.consumers.delete(step.id);
			break;
		case "krelease":
			state.keyedConsumers.get(step.id)?.ref.release();
			state.keyedConsumers.delete(step.id);
			break;
		case "decide": {
			// Another decision retries a failed object or shows its denial (§6 "A failed admitted object follows its
			// admission"); an equal one does nothing.
			if (!sameDecision(world.decisions[step.who], step.decision)) world.broken.delete(step.who);
			world.decisions[step.who] = step.decision;
			const access = await server.get(Access, {}, ctx);
			await access.set(null, ctx);
			access.release();
			break;
		}
		case "break": {
			const self = shared.selves.get(step.who);
			const bound = [...state.consumers.values()].some(
				(held) =>
					whoOf(held) === step.who &&
					bindingOf(spec, world, held).kind === "bound" &&
					(held.at === "local" || world.linkUp),
			);
			if (self === undefined || !bound) break;
			world.broken.add(step.who);
			failLive(objects, self, new ChordError({ code: "unavailable", message: "broke live" }));
			break;
		}
		case "retry": {
			const held = state.consumers.get(step.id);
			if (held === undefined || (held.at === "link" && !world.linkUp)) break;
			// A retry of a failed object's reference starts an attempt; of a waiting or denied one changes nothing here.
			if (bindingOf(spec, world, held).kind === "broken") world.broken.delete(whoOf(held));
			held.ref.retry();
			break;
		}
		case "drop":
			world.linkUp = false;
			state.link.close();
			break;
		case "reconnect":
			world.linkUp = true;
			state.link = connect(server, client);
			break;
		case "value": {
			world.base[step.member] = step.value;
			const values = await server.get(Values, {}, ctx);
			await values.set({ member: step.member, value: "" }, ctx);
			values.release();
			break;
		}
		case "kput": {
			const provider = world.keyed.provider;
			if (provider === undefined || !keyedMembersAt(spec, provider.version).has(step.member)) break;
			const docs = world.keyed.docs;
			docs[step.member] = { ...docs[step.member], [step.key]: step.value };
			const writer = (await server.get(state.keyedContracts[provider.version - 1]!, {}, ctx)) as unknown as {
				put(args: object, context: typeof ctx): Promise<unknown>;
				release(): void;
			};
			await writer.put({ member: step.member, key: step.key, value: step.value }, ctx);
			writer.release();
			break;
		}
		case "emit":
			for (const held of state.consumers.values()) await subscribe(spec, held);
			for (const [who, sources] of shared.live) {
				const sent = new Map<string, string>();
				for (const [member, { emit, shape }] of sources) {
					const value = `e${++state.emits}`;
					try {
						emit(encode(shape.a, value));
						sent.set(member, value);
					} catch {
						// A sealed attempt's source: nothing is emitted.
					}
				}
				state.emitted.set(who as Who, sent);
			}
			break;
		case "call": {
			const mismatch = await checkCalls(spec, world, state.consumers, index);
			if (mismatch !== undefined) return { category: "call", message: mismatch };
			break;
		}
	}
	expectAll(state);
	return undefined;
}

/** Moves every consumer's expected view on to the world as it is now. */
export function expectAll(state: Run): void {
	const { spec, world } = state;
	// An object nobody holds any more ends: its failure goes with it.
	for (const who of world.broken)
		if (!objectLives(spec, world, state.consumers.values(), who)) world.broken.delete(who);
	for (const held of state.consumers.values()) {
		const next = expected(spec, world, held, held.memory);
		held.view = next.view;
		held.memory = next.memory;
	}
	for (const held of state.keyedConsumers.values()) {
		const values = keyedBinding(spec, world, held.version);
		held.bound = values !== undefined;
		if (values !== undefined) held.memory = values;
	}
	if (state.pinned !== undefined) {
		const pin = [...keyedMembersAt(spec, 1)].find((member) => member.startsWith("k"))!;
		const values = keyedBinding(spec, world, 1);
		if (values !== undefined) state.pinned.memory = (values.get(`${pin}/a`) as { n: string }).n;
	}
}

/** Reloads the server with the run's plugins (an unchanged plugin is untouched). */
export async function reload(state: Run): Promise<void> {
	const { world, provider, keyed: keyedProvider } = state.plugins;
	const plugins = [
		world,
		...(provider === undefined ? [] : [provider]),
		...(keyedProvider === undefined ? [] : [keyedProvider]),
	];
	const report = await state.server.reload(plugins, ctx);
	if (report.failed.length > 0) throw new Error(`a plugin did not load: ${JSON.stringify(report.failed)}`);
}

/**
 * A `busy` serve: a call runs on the old provider while it reloads (the restart's old attempt stays open for it), and
 * every consumer calls each of its methods meanwhile. A call made while its reference shows a live binding waits at
 * the gate and runs on the new provider as the model says; one made while it fails or waits rejects at once; the call
 * already running gives its old answer (§21, rules of "Reload restarts every affected object").
 */
export async function busyReload(
	state: Run,
	plugin: PluginFacet<TestPrincipal>,
	before: World,
	index: number,
): Promise<Omit<Failure, "step"> | undefined> {
	const { spec, shared } = state;
	const blocker = findBlocker(state, before, `x${index}`);
	state.plugins.provider = plugin;
	if (blocker === undefined) {
		await reload(state);
		return undefined;
	}
	const busy: Busy = { entered: Promise.withResolvers(), gate: Promise.withResolvers() };
	shared.busy = busy;
	const running = callResult(blocker.handle(encode(blocker.shape.a, `x${index}`), ctx));
	const entered = await Promise.race([busy.entered.promise.then(() => true), delay(1000).then(() => false)]);
	if (!entered) {
		shared.busy = undefined;
		busy.gate.resolve();
		return { category: "busy", message: `${blocker.held.label} ${blocker.member}() never ran` };
	}
	const reloading = reload(state);
	// The restart's old attempt stays open for the running call; the reload commits before the drain.
	for (let round = 0; round < 200 && !objects.some((object) => object.deref()?.openOldAttempt !== undefined); round++)
		await delay(0);
	// What each reference shows when it calls: a failure rejects at once; live or loading, the call waits at the gate
	// (or parks) and runs on the new provider.
	const parked: { held: Held; member: string; shown: string; call: Promise<Outcome> }[] = [];
	for (const held of state.consumers.values()) {
		if (held.view.status === "loading") continue;
		for (const [member, shape] of membersAt(spec, held.version)) {
			const handle = methodHandle(spec, held, member);
			const shown = held.ref.state.value.kind;
			if (handle !== undefined)
				parked.push({ held, member, shown, call: callResult(handle(encode(shape.a, `y${index}`), ctx)) });
		}
	}
	shared.busy = undefined;
	busy.gate.resolve();
	await reloading;
	expectAll(state);
	const settled = await settle(() => compareAll(state));
	if (settled !== undefined) return settled;
	const old = await running;
	if (!fits(blocker.want, old))
		return {
			category: "busy call",
			message: `${blocker.held.label} ${blocker.member}() running at the reload: expected ${JSON.stringify(blocker.want)}, saw ${JSON.stringify(old)}`,
		};
	for (const { held, member, shown, call } of parked) {
		const want =
			shown === "failed" ? thrown("*") : expectedCall(spec, state.world, held, held.view, member, `y${index}`);
		const got = await call;
		if (!fits(want, got))
			return {
				category: "parked call",
				message: `${held.label} ${member}() made while the provider reloaded (${shown}, then ${held.view.status}): expected ${JSON.stringify(want)}, saw ${JSON.stringify(got)}`,
			};
	}
	return undefined;
}

/** A live consumer's method call that reaches the provider's code (a value expected), to keep the old attempt busy. */
export function findBlocker(state: Run, before: World, x: string) {
	const { spec } = state;
	for (const held of state.consumers.values()) {
		if (held.view.status !== "live") continue;
		for (const [member, shape] of membersAt(spec, held.version)) {
			const handle = methodHandle(spec, held, member);
			if (handle === undefined) continue;
			const want = expectedCall(spec, before, held, held.view, member, x);
			if (want.kind === "value") return { held, member, shape, handle, want };
		}
	}
	return undefined;
}

/** `member` of `held` when it is a method the reference shows or showed before. */
export function methodHandle(spec: Case, held: Held, member: string) {
	if (poolOf(spec, member).kind !== "method") return undefined;
	return (held.ref[member] ?? held.handles.get(member)) as
		| ((args: unknown, context: typeof ctx) => Promise<unknown>)
		| undefined;
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A link from `client` to `server`, the server's side acting as the owner. */
export function connect(server: Host<TestPrincipal>, client: Host<TestPrincipal>) {
	const [serverEnd, clientEnd] = memoryLinkPair();
	server.accept(serverEnd, { principal: { kind: "owner" }, codec: testCodec() }, ctx);
	client.connect(clientEnd, { principal: { kind: "server" }, codec: testCodec() }, ctx);
	return clientEnd;
}

export function sameDecision(a: Decision, b: Decision): boolean {
	if (a.kind === "allow" && b.kind === "allow")
		return [...new Set(a.granted)].sort().join() === [...new Set(b.granted)].sort().join();
	return JSON.stringify(a) === JSON.stringify(b);
}

export function followed(label: string, ref: DynRef): Followed {
	return { label, ref, watched: undefined, frames: [], read: undefined, violations: [] };
}

/** A state as the checks compare it: its kind, cause, error code and message, details. */
export function stateKey(state: RefState): string {
	if (state.kind === "failed") {
		const { kind, error } = state.cause;
		return `failed ${kind} ${error.code} ${error.message} ${JSON.stringify(error.details ?? null)}`;
	}
	return state.kind === "ended" ? `ended ${state.error.message}` : state.kind;
}

/**
 * Follows a reference's state watch: its last value (the getter must agree once settled) and this step's frames, of
 * which no two in a row are equal (a change is one notification, §7). `check` sees each value while it is current.
 */
export function watchState(held: Followed, check: (state: RefState) => void): void {
	void held.ref.state.watch(ctx).then((watch) =>
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			const key = stateKey(call.value);
			if (held.frames.at(-1) === key) held.violations.push(`two equal state frames in a row: ${key}`);
			held.frames.push(key);
			held.watched = call.value;
			if (stateKey(held.ref.state.value) === key) check(call.value);
		}),
	);
}

/**
 * The grant on every state the reference reports: live, a grantable member is there exactly when `granted` has it and
 * a granted state member reads (slice 15 §1.4, §7 test 8: `granted` and the members change in one batch); loading or
 * failed (not denied), `granted` is the last live binding's, empty before the first and after a denial (§1.4: a
 * rebind, a replacement loading, a link drop keep it).
 */
export function grantInvariant(spec: Case, held: Held, state: RefState): void {
	const granted = [...held.ref.granted].sort();
	if (state.kind === "failed" && state.cause.kind === "denied") held.lastGranted = [];
	if (state.kind === "loading" || (state.kind === "failed" && state.cause.kind !== "denied")) {
		if (granted.join() !== held.lastGranted.join())
			held.violations.push(`${state.kind} with granted [${granted}], its last binding's [${held.lastGranted}]`);
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
}

/** Subscribes to every event member the reference shows that it has not subscribed to yet. */
export async function subscribe(spec: Case, held: Held): Promise<void> {
	for (const [member] of membersAt(spec, held.version)) {
		const handle = held.ref[member] as EventMember<JsonValue> | undefined;
		if (poolOf(spec, member).kind !== "event" || handle === undefined || held.subscribed.has(member)) continue;
		held.subscribed.add(member);
		await handle.on(({ value }) => held.received.push({ member, value }), ctx);
	}
}

/** Watches every key of every keyed member once the reference is live, kept from then on. */
export async function watchKeys(spec: Case, held: KeyedHeld): Promise<void> {
	if (held.ref.state.value.kind !== "live") return;
	for (const member of keyedMembersAt(spec, held.version)) {
		if (!member.startsWith("k")) continue;
		for (const key of KEYS) {
			if (held.watches.has(`${member}/${key}`)) continue;
			const keyedMember = held.ref[member] as {
				watch(key: string, context: typeof ctx): Promise<WatchHandle<JsonValue> | undefined>;
			};
			const watch = await keyedMember.watch(key, ctx);
			if (watch === undefined) return;
			watch.start(async () => {});
			held.watches.set(`${member}/${key}`, watch);
		}
	}
}

/** Waits until every check holds, and keeps holding; else the last mismatch. */
export async function settle(
	compare: () => Omit<Failure, "step"> | undefined,
): Promise<Omit<Failure, "step"> | undefined> {
	let stable = 0;
	let last: Omit<Failure, "step"> | undefined;
	for (let round = 0; round < SETTLE_MAX; round++) {
		if (round % 4 === 3) await delay(0);
		else await new Promise((resolve) => setImmediate(resolve));
		last = compare();
		stable = last === undefined ? stable + 1 : 0;
		if (stable >= 4 && round >= SETTLE_MIN) return undefined;
	}
	return last;
}

/** Every check of the settled world: each consumer against the model, the state invariants, objects and waits. */
export function compareAll(state: Run): Omit<Failure, "step"> | undefined {
	const { spec, world } = state;
	for (const held of everyFollowed(state)) {
		const found = stateChecks(held);
		if (found !== undefined) return found;
	}
	for (const held of state.consumers.values()) {
		const seen = observe(spec, held);
		const field = differs(held.view, seen);
		if (field !== undefined) {
			const mismatch =
				field === "status" ? `${held.view.status} shown ${seen.status}` : `${held.view.status}: ${field}`;
			return {
				category: `${mismatch} (${held.at})`,
				message: `${held.label} ${mismatch}:\n  expected ${JSON.stringify(held.view)}\n  saw      ${JSON.stringify(seen)}`,
			};
		}
		const events = expectedEvents(spec, world, held, held.view, state.emitted);
		const got = [...held.received].sort((a, b) => a.member.localeCompare(b.member));
		if (JSON.stringify(events) !== JSON.stringify(got))
			return {
				category: "event",
				message: `${held.label} events:\n  expected ${JSON.stringify(events)}\n  saw      ${JSON.stringify(got)}`,
			};
	}
	for (const held of state.keyedConsumers.values()) {
		const found = keyedCheck(spec, held);
		if (found !== undefined) return found;
	}
	return pinnedCheck(state) ?? objectsCheck(state) ?? waitsCheck(state);
}

/**
 * A reference's state checks: one object per read while nothing changes (a native watch and React's external store
 * compare by identity), the getter agreeing with the watch's last value, and the violations its watch found.
 */
export function stateChecks(held: Followed): Omit<Failure, "step"> | undefined {
	if (held.violations.length > 0) return { category: "invariant", message: `${held.label}: ${held.violations[0]}` };
	const state = held.ref.state.value;
	const key = stateKey(state);
	if (held.ref.state.value !== state)
		return { category: "state identity", message: `${held.label}: a new state object per read (${key})` };
	const before = held.read;
	held.read = { state, key };
	if (before !== undefined && before.key === key && before.state !== state)
		return { category: "state identity", message: `${held.label}: a new state object without a change (${key})` };
	if (held.watched !== undefined && stateKey(held.watched) !== key)
		return {
			category: "state notification",
			message: `${held.label}: reads ${key}, its watch's last value is ${stateKey(held.watched)}`,
		};
	return undefined;
}

/** A keyed consumer against the model: live while bound, else waiting; plain members and key watches as last bound. */
export function keyedCheck(spec: Case, held: KeyedHeld): Omit<Failure, "step"> | undefined {
	const state = held.ref.state.value;
	const status = state.kind === "failed" ? state.cause.kind : state.kind;
	const want = held.bound ? "live" : "waiting";
	const seen: Record<string, unknown> = { status };
	const expected: Record<string, unknown> = { status: want };
	for (const member of keyedMembersAt(spec, held.version)) {
		if (member.startsWith("k")) continue;
		const value = held.memory?.get(member);
		expected[member] = value === undefined ? "throws" : value;
		try {
			seen[member] = (held.ref[member] as { value: JsonValue }).value;
		} catch {
			seen[member] = "throws";
		}
	}
	for (const [key, watch] of held.watches) {
		expected[key] = held.memory?.get(key);
		seen[key] = watch.value;
	}
	if (JSON.stringify(seen) === JSON.stringify(expected)) return undefined;
	const field = Object.keys(expected).find((key) => JSON.stringify(seen[key]) !== JSON.stringify(expected[key]));
	return {
		category: `keyed ${field === "status" ? `${want} shown ${status}` : field?.includes("/") ? "watch" : "member"}`,
		message: `${held.label}:\n  expected ${JSON.stringify(expected)}\n  saw      ${JSON.stringify(seen)}`,
	};
}

/** The factory pin of key "a" at v1 reads its last bound value (a pin re-pins on each new instance, §7). */
export function pinnedCheck(state: Run): Omit<Failure, "step"> | undefined {
	const pinned = state.pinned;
	if (pinned === undefined || pinned.memory === undefined || pinned.ref.state.value.kind !== "live") return undefined;
	const n = (pinned.ref.n as { value: string }).value;
	if (n === pinned.memory) return undefined;
	return {
		category: "keyed pin",
		message: `a factory pin of "a" at v1 reads ${JSON.stringify(n)}, expected ${JSON.stringify(pinned.memory)}`,
	};
}

/** The provider's object for each principal lives exactly while the model says (`Probe`: its admission's request). */
export function objectsCheck(state: Run): Omit<Failure, "step"> | undefined {
	for (const who of ["server", "owner"] as const) {
		const lives = objectLives(state.spec, state.world, state.consumers.values(), who);
		const open = (state.shared.probes.get(who) ?? 0) > 0;
		if (lives !== open)
			return {
				category: lives ? "object ended" : "object lives",
				message: `the ${who} principal's provider object ${open ? "lives" : "ended"}; the model says it ${lives ? "lives" : "ended"}`,
			};
	}
	return undefined;
}

/**
 * Every reference waiting unbound is on its host's clock (reported `unbound_long` after 5 s): at least one wait per
 * same-host consumer and per version held over the link (references of one version share a hold).
 */
export function waitsCheck(state: Run): Omit<Failure, "step"> | undefined {
	const { spec, world } = state;
	let waiting = 0;
	const linkVersions = new Set<number>();
	for (const held of state.consumers.values()) {
		if (held.view.status !== "waiting") continue;
		if (held.at === "local") waiting++;
		else linkVersions.add(held.version);
	}
	for (const held of state.keyedConsumers.values()) if (!held.bound) waiting++;
	if (state.pinned !== undefined && keyedBinding(spec, world, 1) === undefined) waiting++;
	waiting += linkVersions.size;
	if (unboundWaits.size >= waiting) return undefined;
	return {
		category: "unbound clock",
		message: `${unboundWaits.size} requests on the unbound clock; the model has at least ${waiting} waiting unbound`,
	};
}

/** What a reference shows now, in the model's terms (an identity change of a member is a violation). */
export function observe(spec: Case, held: Held): View {
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
export function differs(expected: View, seen: View): string | undefined {
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
export async function checkCalls(
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
export function fits(want: Outcome, got: Outcome): boolean {
	if (want.kind === "value") return got.kind === "value" && JSON.stringify(got.value) === JSON.stringify(want.value);
	return got.kind === "throws" && (want.code === "*" || want.code === got.code);
}

export async function callResult(call: Promise<unknown>): Promise<Outcome> {
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

export function codeOf(error: unknown): string {
	return (error as { code?: string })?.code ?? String(error);
}

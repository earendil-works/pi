import type { Cell } from "./cell.ts";
import { type AnyContract, bind, coverage } from "./contract.ts";
import { asChordError, ChordError, invalid, isChordError } from "./errors.ts";
import type { CodeVersionState, Facet, HostImpl, PluginRef, Serve } from "./host.ts";
import {
	type Factory,
	hostLifetime,
	makeService,
	memberSchemas,
	type ObjectImpl,
	RefImpl,
	type ResourceImpl,
	type Run,
	type ServeOptions,
	type Service,
	type StagedListeners,
} from "./object.ts";
import { holdPublications } from "./publish.ts";
import type { RegistryTable } from "./registry.ts";
import { assertValid, deepEqual } from "./schema.ts";
import type { Readable } from "./types.ts";

export interface ReloadOptions {
	/** Facet names to remove. */
	readonly remove?: readonly string[];
	/** Milliseconds the gate waits for grandfathered roots (default 5000). Missed: the reload aborts. */
	readonly gateDeadline?: number;
	/** Milliseconds to wait for the previous code version to retire first (default 5000). Missed: it is retired anyway. */
	readonly retireDeadline?: number;
	/** Server: facet modules for child hosts by host-name prefix (longest wins). Every connected host participates. */
	readonly remote?: Readonly<Record<string, readonly string[]>>;
	/** Server: facet names to remove on child hosts, by the same host-name prefix rules. */
	readonly remoteRemove?: Readonly<Record<string, readonly string[]>>;
	/** Server: milliseconds to wait for every child's vote (default: gate + retire deadlines + 5000). */
	readonly voteDeadline?: number;
}

export interface ReloadReport {
	readonly codeVersion: number;
	readonly previous: number;
	readonly changed: readonly string[];
	readonly removed: readonly string[];
	/** Addresses of objects whose new factory was installed. */
	readonly prepared: readonly string[];
	/** Addresses of objects that went through the gate. */
	readonly gated: readonly string[];
	/**
	 * Cluster reloads: what each participating child host prepared, by host name (its vote; the child commits it after
	 * the server). Absent for local reloads.
	 */
	readonly children?: Readonly<Record<string, ReloadReport>>;
}

interface Candidate {
	readonly object: ObjectImpl;
	readonly service: Service;
	readonly run: Run;
	/** Why the object needs the gate (empty: compatible). */
	readonly reasons: string[];
	/** New exclusive resources and their new dependents, opened at the gate. */
	readonly atGate: ResourceImpl[];
	/** Old exclusive resources closed at the gate. */
	readonly replaced: ResourceImpl[];
	readonly migrated: Map<Cell<unknown>, unknown>;
	/** Values of the run's derivations over the candidate (migrated) values, validated. */
	derived: Map<unknown, unknown>;
	/** Listener subscriptions made at the end of prepare, activated by the commit. */
	staged: StagedListeners | undefined;
}

/**
 * Computes the new derivation functions over the candidate values and validates every prospective value (migrated
 * cells and derivations) against every schema that will apply after the commit: the cell's new schema and the new
 * implementation's remote state-member schemas. A failure fails prepare; the commit then installs without re-checking.
 */
function dryRun(candidate: Candidate): void {
	const { run, migrated, service, object } = candidate;
	const exposed = memberSchemas(service, run.implementation);
	for (const [cell, value] of migrated) {
		for (const schema of exposed.get(cell) ?? [])
			assertValid("state", `${object.address}: migrated state ${cell.key}`, schema, value);
	}
	const values = new Map<unknown, unknown>(migrated);
	const derives = [...run.decls.derives].sort(([, a], [, b]) => a.seq - b.seq);
	for (const [name, derived] of derives) {
		const value = derived.compute((source) => (values.has(source) ? values.get(source) : candidateValue(source)));
		for (const schema of exposed.get(derived) ?? [])
			assertValid("state", `${object.address}: derivation ${name}`, schema, value);
		values.set(derived, value);
	}
	candidate.derived = values;
}

/**
 * A source's value for a dry run. A reference to a provider this reload upgrades too reads nothing before the commit
 * (its new contract does not bind the old code): the dry run computes without it, the commit with the real value.
 */
function candidateValue(source: Readable<unknown>): unknown {
	try {
		return source.value;
	} catch (error) {
		if (isChordError(error, "not_ready") || isChordError(error, "not_in_variant")) return undefined;
		throw error;
	}
}

/** A reload error keeps the underlying code (`contract_mismatch`, `invalid`, ...) and says it aborted the reload. */
export function reloadError(error: unknown): ChordError {
	const cause = asChordError(error, "reload");
	if (/^reload aborted/.test(cause.message.replace(/^[^:]*: /, ""))) return cause;
	return new ChordError(cause.code, `reload aborted: ${cause.message}`, {
		cause,
		reason: cause.reason,
		details: cause.details,
	});
}

/** Serialized: a second reload while one runs is rejected. */
export async function runReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
): Promise<ReloadReport> {
	const reload = await beginReload(host, plugins, options);
	try {
		await reload.prepare();
		return reload.commit();
	} finally {
		endReload(host);
	}
}

/** Takes the host's reload slot and loads the plugin modules. Pair with `endReload`. */
export async function beginReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
	codeVersion?: number,
): Promise<Reload> {
	if (host.reloading) {
		throw new ChordError("unavailable", "a reload is already running", { reason: "reload_running" });
	}
	host.reloading = true;
	try {
		return new Reload(host, await host.resolve(plugins), options, codeVersion);
	} catch (error) {
		host.reloadEnded();
		throw reloadError(error);
	}
}

export function endReload(host: HostImpl): void {
	host.reloadEnded();
}

/** Most milliseconds a forced retirement waits for aborted roots to settle before it closes what they used. */
const ABORTED_ROOTS_GRACE = 1000;

/** Resolves true once `ready()` holds (checked whenever retirement-relevant state changes), false after `ms`. */
function until(host: HostImpl, ready: () => boolean, ms: number): Promise<boolean> {
	if (ready()) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			stop();
			resolve(false);
		}, ms);
		const stop = host.watchRetirement(() => {
			if (!ready()) return;
			clearTimeout(timer);
			stop();
			resolve(true);
		});
	});
}

/** One reload on one host: `prepare` (load, prepare, gate), then `commit` or `rollback`. */
export class Reload {
	readonly host: HostImpl;
	readonly facets: readonly Facet[];
	readonly options: ReloadOptions;
	/** Code version id to commit (issued by the coordinating server); a local reload allocates one. */
	readonly codeVersion: number | undefined;
	readonly candidates = new Map<ObjectImpl, Candidate>();
	readonly abort = new AbortController();
	readonly closed: [ObjectImpl, ResourceImpl][] = [];
	services = new Map<string, Service>();
	changed = new Set<string>();
	removed = new Set<string>();
	tables = new Map<string, RegistryTable<unknown>>();
	gated: Candidate[] = [];
	rolledBack = false;
	/** Objects of types this reload adds, with their staged listeners: their runtime starts at commit. */
	readonly deferred = new Map<ObjectImpl, StagedListeners>();
	/** This reload's run of each facet it loads (`FacetApi.signal`): installed at commit, aborted at rollback. */
	readonly facetRuns = new Map<string, AbortController>();

	constructor(host: HostImpl, facets: readonly Facet[], options: ReloadOptions, codeVersion?: number) {
		this.host = host;
		this.facets = facets;
		this.options = options;
		this.codeVersion = codeVersion;
	}

	/** Everything up to the commit. On failure the host is rolled back and the underlying error is thrown. */
	async prepare(): Promise<void> {
		try {
			await this.waitForRetirement();
			this.load();
			this.checkProviders();
			await this.prepareAll();
			// From here new objects of changed types are rejected (upgrade_conflict, retryable) until commit or abort,
			// so the candidate set is final once the activations already in flight have been prepared.
			this.host.gating = this.changed;
			await this.withDeadline(this.prepareAll(), "activations in flight did not finish");
			this.checkRefs();
			this.tables = this.host.buildTables(this.entries());
			await this.gate();
			this.#alive();
			this.#stage();
		} catch (error) {
			await this.rollback();
			throw reloadError(error);
		}
	}

	/** What a successful prepare will commit (a child sends it with its vote). */
	summary(): ReloadReport {
		const live = [...this.candidates.values()].filter(({ object }) => object.status === "live");
		return {
			codeVersion: this.host.pending?.id ?? this.host.current.id,
			previous: this.host.current.id,
			changed: [...this.changed],
			removed: [...this.removed],
			prepared: live.map(({ object }) => object.address),
			gated: this.gated.map(({ object }) => object.address),
		};
	}

	/** After every await of prepare: a rollback meanwhile (abort from the coordinator) ends it. */
	#alive(): void {
		if (this.rolledBack) throw new ChordError("aborted", "reload aborted while preparing", { reason: "aborted" });
	}

	/**
	 * Subscribes every new listener now, buffering its events, so a failing source fails prepare instead of leaving a
	 * half-installed code version. Objects running only the new code (types this reload adds) are staged too.
	 */
	#stage(): void {
		for (const candidate of this.candidates.values()) {
			if (candidate.object.status === "live")
				candidate.staged = candidate.object.stageListeners(candidate.run.decls);
		}
		for (const object of this.host.objects.values()) {
			if (object.status === "live" && object.deferredRuntime)
				this.deferred.set(object, object.stageListeners(object.decls));
		}
	}

	/**
	 * Retires the previous code version before loading the next one (a host keeps two). Waits until its roots ended and,
	 * on a child host, its parent retired it too (`retire` frame), at most `retireDeadline`. Past the deadline it is
	 * retired anyway: its remaining roots are aborted first and get a short grace to stop, so they see cancellation
	 * before the resources only that code version used are closed; their next call is `superseded`.
	 */
	async waitForRetirement(): Promise<void> {
		const host = this.host;
		const previous = host.previous;
		if (previous === undefined) return;
		const deadline = this.options.retireDeadline ?? 5000;
		const gone = (): boolean => host.previous !== previous;
		if (!(await until(host, () => gone() || host.retirable(), deadline)) && !gone()) {
			previous.abort.abort(new ChordError("superseded", `code version ${previous.id} was retired`));
			await until(host, () => gone() || previous.roots.size === 0, Math.min(deadline, ABORTED_ROOTS_GRACE));
		}
		if (!gone()) host.retire();
	}

	/** Builds the candidate service table: unchanged services plus everything the given facets serve. */
	load(): void {
		const replaced = new Set([...this.facets.map((facet) => facet.name), ...(this.options.remove ?? [])]);
		const current = this.host.current.services;
		this.services = new Map([...current].filter(([, service]) => !replaced.has(service.facet)));
		for (const facet of this.facets) {
			const run = new AbortController();
			this.facetRuns.set(facet.name, run);
			facet.setup(
				this.host.facetApi(
					((type: AnyContract, factory: Factory<AnyContract>, options: ServeOptions = {}) =>
						this.host.serveInto(this.services, makeService(type, factory, options, facet.name))) as Serve,
					run.signal,
				),
			);
		}
		for (const [name, service] of this.services) if (current.get(name) !== service) this.changed.add(name);
		for (const name of current.keys()) if (!this.services.has(name)) this.removed.add(name);
		this.host.pending = {
			id: this.host.nextCodeVersionId(this.codeVersion),
			services: this.services,
			tables: new Map(),
			roots: new Map(),
			abort: new AbortController(),
		};
	}

	async withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
		const deadline = this.options.gateDeadline ?? 5000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new ChordError("aborted", `${what} within ${deadline} ms`, { reason: "deadline" })),
				deadline,
			);
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Same contract version must cover the old description (forgotten bump); facets' `uses` must bind. */
	checkProviders(): void {
		for (const name of this.changed) {
			const next = this.services.get(name)!.contract;
			const old = this.host.current.services.get(name)?.contract;
			if (old === undefined || old.version !== next.version) continue;
			const reason = coverage(next.description, old.description);
			if (reason !== undefined) {
				throw new ChordError(
					"contract_mismatch",
					`${name}@${next.version} changed incompatibly without a version bump (${reason})`,
				);
			}
		}
		const facets = new Map(this.host.facets);
		for (const facet of this.facets) facets.set(facet.name, facet);
		for (const name of this.options.remove ?? []) facets.delete(name);
		for (const facet of facets.values()) {
			for (const token of facet.uses ?? []) {
				const service = this.services.get(token.name);
				if (service !== undefined && this.changed.has(token.name))
					bind(service.contract, service.options.accepts, token);
			}
		}
	}

	/**
	 * Prepares every live object of a changed type, including objects that activate meanwhile, to a fixpoint. Objects
	 * already running the new code (types this reload adds) are skipped.
	 */
	async prepareAll(): Promise<void> {
		for (;;) {
			const todo = [...this.host.objects.values()].filter(
				(object) =>
					this.changed.has(object.typeName) &&
					!this.candidates.has(object) &&
					object.service !== this.services.get(object.typeName) &&
					(object.status === "live" || object.status === "activating"),
			);
			if (todo.length === 0) return;
			await Promise.allSettled(todo.map((object) => object.ready));
			this.#alive();
			for (const object of todo) {
				if (object.status === "live" && object.service !== this.services.get(object.typeName)) {
					await this.prepareObject(object);
					this.#alive();
				}
			}
		}
	}

	/** Runs the new factory in recording mode and opens what can be opened without the gate. */
	async prepareObject(object: ObjectImpl): Promise<void> {
		const service = this.services.get(object.typeName)!;
		const run = object.run(service, object.decls);
		const candidate: Candidate = {
			object,
			service,
			run,
			reasons: [],
			atGate: [],
			replaced: [],
			migrated: new Map(),
			derived: new Map(),
			staged: undefined,
		};
		this.candidates.set(object, candidate);
		// Each cell carries its own version: a raised one gates and migrates, a schema change without one is refused.
		for (const [name, cell] of run.decls.cells) {
			if (object.decls.cells.get(name) !== cell) continue;
			const from = object.decls.cellVersions.get(name) ?? 1;
			const to = run.decls.cellVersions.get(name) ?? 1;
			if (to < from)
				throw invalid("state", `${object.address}: version of state ${name} lowered from ${from} to ${to}`);
			if (to > from) candidate.reasons.push(`state ${name} version ${from} -> ${to}`);
			else if (!deepEqual(cell.schema, run.decls.cellSchemas.get(name)))
				throw invalid("state", `${object.address}: schema of state ${name} changed without a version bump`);
		}
		const deferred = new Set<ResourceImpl>();
		for (const resource of run.created.resources) {
			if (resource.exclusive || resource.deps.some((dep) => deferred.has(dep as ResourceImpl)))
				deferred.add(resource);
		}
		for (const resource of deferred) {
			candidate.atGate.push(resource);
			const old = object.decls.resources.get(resource.key);
			if (resource.exclusive && old?.exclusive && old.state === "open") candidate.replaced.push(old);
		}
		if (deferred.size > 0) candidate.reasons.push("exclusive resource replaced");
		await object.open(
			run.created.resources.filter((resource) => !deferred.has(resource)),
			run.created.refs,
			this.abort.signal,
		);
		await object.waitHydrated(run);
		// Cells this reload adds read their first value once the new resources are open (gated objects: at the gate);
		// the derivations over them are checked after.
		if (candidate.reasons.length === 0) {
			await object.initCells(run, this.abort.signal);
			dryRun(candidate);
		}
	}

	/**
	 * Every reference that survives into the new code version must bind to the new provider. Browser references don't block a
	 * reload: after the commit they get `upgrade_required` instead.
	 */
	checkRefs(): void {
		const dropped = new Set<unknown>();
		for (const { object, run } of this.candidates.values()) {
			for (const ref of object.decls.refs.values())
				if (![...run.decls.refs.values()].includes(ref)) dropped.add(ref);
		}
		for (const object of this.host.objects.values()) {
			const service = this.services.get(object.typeName);
			if (service === undefined || !this.changed.has(object.typeName)) continue;
			for (const ref of object.refs) {
				// The host's bootstrap reference follows this provider at commit; it is not an old-code consumer.
				if (ref === this.host.hostObjects.get(object.typeName)) continue;
				if (!dropped.has(ref) && ref.owner !== "client")
					bind(service.contract, service.options.accepts, ref.contract);
			}
		}
	}

	entries(): [ObjectImpl, Run["decls"]][] {
		return this.host
			.liveDecls(true)
			.filter(([object]) => !this.removed.has(object.typeName))
			.map(([object, decls]) => [object, this.candidates.get(object)?.run.decls ?? decls]);
	}

	/**
	 * Admission cut, wait for grandfathered roots (deadline), replace exclusive resources, migrate into private
	 * copies. Old tasks of gated objects are stopped at the cut; listener events are queued until commit or abort.
	 */
	async gate(): Promise<void> {
		this.gated = [...this.candidates.values()].filter(
			(candidate) => candidate.reasons.length > 0 && candidate.object.status === "live",
		);
		const drained = this.gated.map(({ object }) => {
			const grandfathered = new Set(object.leases.keys());
			return new Promise<void>((resolve) => {
				object.gate = { grandfathered, queue: [], drained: resolve };
				object.stopTasks();
				if (grandfathered.size === 0) resolve();
			});
		});
		const deadline = this.options.gateDeadline ?? 5000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			Promise.all(drained).then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), deadline);
			}),
		]);
		clearTimeout(timer);
		if (timedOut) {
			const blocking = this.gated.flatMap(({ object }) => [...(object.gate?.grandfathered ?? [])]);
			throw new ChordError(
				"aborted",
				`gate deadline (${deadline} ms) missed; blocking roots: ${blocking.join(", ")}`,
				{
					reason: "gate_deadline",
					details: { blocking },
				},
			);
		}
		this.#alive();
		for (const candidate of this.gated) {
			const { object } = candidate;
			for (const old of candidate.replaced) {
				// Owned by the rollback before closing: a failing close must still be restored.
				this.closed.push([object, old]);
				await old.close(object.openOrder);
			}
			await object.open(candidate.atGate, [], this.abort.signal);
			this.#alive();
			await object.initCells(candidate.run, this.abort.signal);
			this.#alive();
		}
		for (const candidate of this.gated) this.migrate(candidate);
	}

	migrate(candidate: Candidate): void {
		const { object, run } = candidate;
		for (const [name, cell] of run.decls.cells) {
			if (object.decls.cells.get(name) !== cell) continue;
			const schema = run.decls.cellSchemas.get(name)!;
			const from = object.decls.cellVersions.get(name) ?? 1;
			const fn = run.decls.cellMigrations.get(name);
			let value: unknown;
			if ((run.decls.cellVersions.get(name) ?? 1) > from && fn !== undefined)
				value = fn(structuredClone(cell.value), from);
			else if (!deepEqual(cell.schema, schema)) value = cell.value;
			else continue;
			assertValid("state", `${object.address}: migrated state ${name}`, schema, value);
			candidate.migrated.set(cell, value);
		}
		dryRun(candidate);
	}

	async rollback(): Promise<void> {
		if (this.rolledBack) return;
		this.rolledBack = true;
		this.abort.abort(new ChordError("aborted", "reload aborted"));
		for (const run of this.facetRuns.values()) run.abort(new ChordError("aborted", "reload aborted"));
		const report = (error: unknown): void => this.host.report(error);
		for (const candidate of this.candidates.values()) candidate.staged?.discard();
		for (const staged of this.deferred.values()) staged.discard();
		for (const { object, run } of this.candidates.values()) {
			object.pending.delete(run.decls);
			await object.unwind(run).catch(report);
		}
		// Replaced exclusive resources are restored; one that cannot be is marked unavailable, never silently closed.
		for (const [object, resource] of this.closed) {
			if (resource.state !== "closed") continue;
			await resource.open(new AbortController().signal, object.openOrder).catch((error: unknown) => {
				resource.markUnavailable();
				report(
					new ChordError("unavailable", `${object.address}: resource ${resource.key} could not be restored`, {
						cause: error,
					}),
				);
			});
		}
		for (const { object } of this.gated) {
			if (object.gate === undefined) continue;
			object.openGate();
			object.startTasks();
		}
		// Objects of types this reload would have added lose their code.
		const reason = new ChordError("gone", "reload aborted; type not served");
		for (const object of [...this.host.objects.values()]) {
			if (!this.host.current.services.has(object.typeName)) await object.dispose(true, reason).catch(report);
		}
		this.host.pending = undefined;
		this.host.gating = undefined;
	}

	/**
	 * Publishes the new code version in one synchronous step. Everything fallible ran in prepare (factories, opens,
	 * migration and derivation checks against the prospective schemas, listener subscriptions), so this only installs.
	 * Observers (state, shapes, registries, listener roots) are notified after the whole step. If an install still
	 * throws, the code version is half-published: the host fails terminally and admits no more work.
	 */
	commit(beforeStart?: () => void): ReloadReport {
		try {
			return holdPublications(() => {
				const report = this.#publish();
				// Installed, not yet started: the coordinator queues its commit frames here, so nothing this code version
				// starts (tasks, host object activations, then the held listener/registry/state notifications) can reach a child
				// first.
				beforeStart?.();
				for (const start of this.#starts.splice(0)) start();
				return report;
			});
		} catch (error) {
			this.host.fail(error);
			throw reloadError(error);
		}
	}

	/** Work that may start new-code-version roots, run after installation (and after the coordinator's commit frames). */
	readonly #starts: (() => void)[] = [];

	#publish(): ReloadReport {
		const host = this.host;
		const previous = host.current;
		const next: CodeVersionState = host.pending!;
		host.pending = undefined;
		host.codeVersions.set(next.id, next);
		host.previous = previous;
		host.current = next;
		const prepared: string[] = [];
		for (const object of [...host.objects.values()]) {
			if (this.removed.has(object.typeName)) continue;
			const candidate = this.candidates.get(object);
			if (candidate === undefined) {
				const installed = object.implementations.get(previous.id);
				if (installed !== undefined) object.implementations.set(next.id, { ...installed, codeVersion: next.id });
				continue;
			}
			if (object.status !== "live") continue;
			this.install(candidate, next.id);
			prepared.push(object.address);
		}
		for (const { object, run, staged } of this.candidates.values()) {
			if (object.status === "live") continue;
			staged?.discard();
			object.pending.delete(run.decls);
			object.unwind(run).catch((error: unknown) => host.report(error));
		}
		// Objects of types this reload adds start their runtime now.
		for (const [object, staged] of this.deferred) {
			if (object.status !== "live") {
				staged.discard();
				continue;
			}
			object.deferredRuntime = false;
			staged.activate();
			this.#starts.push(() => object.startTasks());
		}
		host.installTables(next, this.tables, true);
		const reason = new ChordError("gone", "type no longer served");
		for (const object of [...host.objects.values()]) {
			if (this.removed.has(object.typeName))
				object.dispose(true, reason).catch((error: unknown) => host.report(error));
		}
		for (const name of this.removed) host.hostObjects.delete(name);
		for (const facet of this.facets) host.facets.set(facet.name, facet);
		for (const name of this.options.remove ?? []) host.facets.delete(name);
		// The replaced and removed runs' signals abort after the install, like other observers.
		for (const [name, run] of this.facetRuns) this.#starts.push(() => host.facetRunChanged(name, run));
		for (const name of this.options.remove ?? []) this.#starts.push(() => host.facetRunChanged(name, undefined));
		host.gating = undefined;
		for (const [name, service] of this.services) {
			if (hostLifetime(service) && this.changed.has(name) && host.hostObjects.get(name)?.object?.status !== "live") {
				this.#starts.push(() => host.startHostObject(service));
			}
			// A type whose lifetime became "referenced" lives on only while someone else references its object.
			const pinned = host.hostObjects.get(name);
			if (!hostLifetime(service) && pinned !== undefined) {
				host.hostObjects.delete(name);
				this.#starts.push(() => pinned.release());
			}
		}
		return {
			codeVersion: next.id,
			previous: previous.id,
			changed: [...this.changed],
			removed: [...this.removed],
			prepared,
			gated: this.gated.map(({ object }) => object.address),
		};
	}

	install(candidate: Candidate, codeVersion: number): void {
		const { object, run, service } = candidate;
		const gated = candidate.reasons.length > 0;
		object.pending.delete(run.decls);
		object.stopTasks();
		if (gated) {
			// Old derivations would compute over migrated values; the old implementation can no longer run anyway.
			const kept = new Set(run.decls.derives.values());
			for (const derived of object.decls.derives.values()) if (!kept.has(derived)) derived.detach();
		}
		object.decls = run.decls;
		object.service = service;
		// Kept resources close with the new code's `close`; replaced ones keep their own (closed at retirement).
		for (const [resource, declaration] of run.decls.adopted) resource.adopt(declaration);
		object.implementations.set(codeVersion, {
			codeVersion,
			service,
			implementation: run.implementation,
			decls: run.decls,
		});
		if (gated) {
			// Old code can never run over migrated state: drop the previous implementation now, not at retirement.
			object.minCodeVersion = codeVersion;
			for (const old of [...object.implementations.keys()])
				if (old !== codeVersion) this.host.retireImplementation(object, old);
		}
		// Schemas first, then the values validated against them in prepare.
		object.refreshSchemas();
		for (const [name, cell] of run.decls.cells) {
			const schema = run.decls.cellSchemas.get(name)!;
			if (candidate.migrated.has(cell)) cell.reset(candidate.migrated.get(cell), schema);
			else cell.schema = schema;
		}
		const created = new Set(run.created.derives);
		for (const derived of run.created.derives) derived.attach(candidate.derived);
		for (const derived of run.decls.derives.values()) if (!created.has(derived)) derived.refresh();
		candidate.staged?.activate();
		this.#starts.push(() => object.startTasks());
		object.openGate();
		const pinned = this.host.hostObjects.get(object.typeName);
		if (pinned?.object === object && pinned.contract.fingerprint !== service.contract.fingerprint) {
			const replacement = new RefImpl(object, service.contract, "host");
			// Acquire first: releasing the only reference must not dispose/reopen the surviving host object.
			object.addRef(replacement);
			this.host.hostObjects.set(object.typeName, replacement);
			pinned.release();
		}
		for (const ref of [...object.refs]) {
			// Browser references whose contract no longer binds are told to reload their code (they never block a reload).
			if (ref.owner === "client") {
				try {
					bind(service.contract, service.options.accepts, ref.contract);
				} catch (error) {
					ref.gone(
						new ChordError("upgrade_required", `${object.typeName} changed; reload the web facets`, {
							cause: error,
						}),
					);
					object.release(ref);
					continue;
				}
			}
			ref.shapeChanged();
		}
	}
}

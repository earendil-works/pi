import type { Connection } from "./connection.ts";
import { ChordError } from "./errors.ts";
import type { HostImpl, PluginRef } from "./host.ts";
import { beginReload, endReload, type Reload, type ReloadOptions, type ReloadReport, reloadError } from "./reload.ts";
import { type Frame, toWireError } from "./wire.ts";

// Cross-host reload, coordinated by the server (the host without a parent):
//   server: prepare itself and send `prepare` to every synced child host; collect votes
//   all ok: the server installs its new code version, sends `commit` to every child, and only then starts what may make
// new-code-version calls (tasks, listener and registry callbacks). Links are FIFO, so a child commits before it
//           can receive any frame of a root started in the new code version.
//   any failure or missed vote deadline: `abort` everywhere; each host rolls back to where it was.
// Clients (browsers) are not participants: they see shape/reset pushes, or `upgrade_required`.
// A child that connects behind the server's code version is fenced and reconciled with the same protocol.

let reloadSeq = 0;

const modulesFor = (remote: ReloadOptions["remote"], hostName: string | undefined): string[] => {
	let best: [string, readonly string[]] | undefined;
	for (const entry of Object.entries(remote ?? {})) {
		if (hostName?.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
	}
	return [...(best?.[1] ?? [])];
};

/** A vote, or its rejection after `deadline` milliseconds. */
function awaitVote(connection: Connection, id: number, deadline: number): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const vote = new Promise<unknown>((resolve, reject) => {
		connection.votes.set(id, { resolve, reject });
		timer = setTimeout(() => {
			connection.votes.delete(id);
			reject(new ChordError("aborted", `votes missing after ${deadline} ms`, { reason: "vote_deadline" }));
		}, deadline);
	});
	return vote.finally(() => clearTimeout(timer));
}

export async function runClusterReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
): Promise<ReloadReport> {
	// Participants are the children in step now. Fenced children (behind, being reconciled) reconcile to the new code
	// version afterwards; a child whose hello arrives while the reload runs is synced or reconciled once it ends
	// (`HostImpl.peerHello`).
	const synced = [...host.connections].filter(
		(connection) =>
			connection.role === "downstream" && connection.peer.kind === "host" && connection.open && connection.synced,
	);
	const codeVersion = host.peekNextCodeVersion();
	const reload = await beginReload(host, plugins, options, codeVersion);
	try {
		// Retire first: its `retire` frames reach every child before `prepare` (FIFO), so a child never retires a code
		// version this host still runs roots of.
		await reload.waitForRetirement();
		const participants = synced.filter((connection) => connection.open);
		const id = ++reloadSeq;
		const deadline = options.voteDeadline ?? (options.gateDeadline ?? 5000) + (options.retireDeadline ?? 5000) + 5000;
		const votes = participants.map((connection) => {
			const name = connection.name ?? "child";
			const vote = awaitVote(connection, id, deadline);
			connection.send({
				t: "prepare",
				reload: id,
				codeVersion,
				plugins: modulesFor(options.remote, name),
				options: {
					remove: modulesFor(options.remoteRemove, name),
					gateDeadline: options.gateDeadline,
					retireDeadline: options.retireDeadline,
				},
			});
			return vote.then(
				(report) => [name, report as ReloadReport | undefined] as const,
				(error: unknown) => {
					const cause = reloadError(error);
					throw new ChordError(cause.code, `${name}: ${cause.message}`, { cause, reason: cause.reason });
				},
			);
		});
		let local = false;
		const results = await Promise.allSettled([
			reload.prepare().then(() => {
				local = true;
			}),
			...votes,
		]);
		const failed = results.find((result) => result.status === "rejected");
		if (failed !== undefined) {
			for (const connection of participants) {
				connection.votes.delete(id);
				connection.send({ t: "abort", reload: id });
			}
			if (local) await reload.rollback();
			throw failed.reason;
		}
		const report = reload.commit(() => {
			for (const connection of participants) {
				connection.send({ t: "commit", reload: id });
				connection.peerCodeVersion = codeVersion;
			}
		});
		host.rememberRemoteModules(options.remote, options.remoteRemove);
		const children: Record<string, ReloadReport> = {};
		for (const result of results.slice(1)) {
			if (result.status !== "fulfilled") continue;
			const [name, child] = result.value as readonly [string, ReloadReport | undefined];
			if (child !== undefined) children[name] = child;
		}
		return { ...report, children };
	} finally {
		endReload(host);
	}
}

/**
 * Brings a child that connected behind this host's code version up to it: a reload of the child's modules (the ones
 * cluster reloads gave its name) to this host's current code version, prepared, voted and committed like a cluster
 * reload. Until then the child is fenced: nothing is routed to it. The child's old code is never relabeled as a newer
 * code version.
 */
export async function reconcileChild(host: HostImpl, connection: Connection): Promise<void> {
	for (;;) {
		if (!connection.open) return;
		// Not during a reload of this host: the child is not one of its participants, so whatever it would be synced to
		// now may be superseded by that reload's commit. Recheck once it ended.
		if (host.reloading) {
			await host.whenReloadEnded();
			continue;
		}
		const codeVersion = host.current.id;
		if (connection.peerCodeVersion === codeVersion) {
			connection.markSynced(codeVersion);
			host.announceRetired(connection);
			return;
		}
		// Before `prepare`: the child's prepare first retires its previous code version, which waits for this permission.
		host.announceRetired(connection);
		const id = ++reloadSeq;
		const vote = awaitVote(connection, id, 30_000);
		connection.send({
			t: "prepare",
			reload: id,
			codeVersion,
			plugins: modulesFor(host.remoteModules, connection.name),
			options: { remove: modulesFor(host.remoteRemoved, connection.name) },
		});
		await vote;
		if (host.current.id !== codeVersion) {
			// This host moved on meanwhile: abort and try again with the newer code version.
			connection.send({ t: "abort", reload: id });
			continue;
		}
		connection.send({ t: "commit", reload: id });
		connection.peerCodeVersion = codeVersion;
	}
}

/** One prepare the child received, registered before its first await so an abort or disconnect is never lost. */
interface ChildOperation {
	readonly id: number;
	reload: Reload | undefined;
	state: "loading" | "preparing" | "prepared";
	cancelled: boolean;
}

/**
 * The child side: prepare and vote, then wait for the server's commit or abort. An abort or a lost parent link can
 * arrive at any point: while loading modules, while preparing (pending opens close themselves when they complete),
 * or after the vote. The operation is unwound once its pending work settles, and the reload slot is freed.
 */
export class ChildReloads {
	readonly #host: HostImpl;
	#operation: ChildOperation | undefined;

	constructor(host: HostImpl) {
		this.#host = host;
	}

	handle(connection: Connection, frame: Extract<Frame, { t: "prepare" | "commit" | "abort" }>): void {
		if (frame.t === "prepare") {
			if (this.#operation !== undefined) {
				const error = new ChordError("unavailable", "a reload is already running", { reason: "reload_running" });
				connection.send({ t: "vote", reload: frame.reload, error: toWireError(error) });
				return;
			}
			const operation: ChildOperation = { id: frame.reload, reload: undefined, state: "loading", cancelled: false };
			this.#operation = operation;
			this.#run(operation, connection, frame).catch((error: unknown) => this.#host.report(error));
			return;
		}
		const operation = this.#operation;
		if (operation === undefined || operation.id !== frame.reload) return;
		if (frame.t === "abort") {
			this.#cancel(operation);
			return;
		}
		if (operation.state !== "prepared") return;
		this.#operation = undefined;
		try {
			operation.reload?.commit();
		} finally {
			endReload(this.#host);
		}
	}

	/** The parent link died: nobody will commit, so roll back (now, or once pending work settles). */
	parentLost(): void {
		if (this.#operation !== undefined) this.#cancel(this.#operation);
	}

	#cancel(operation: ChildOperation): void {
		operation.cancelled = true;
		if (operation.state !== "prepared") {
			// Loading or preparing: make prepare fail now; #run unwinds when it settles.
			operation.reload?.rollback().catch((error: unknown) => this.#host.report(error));
			return;
		}
		this.#operation = undefined;
		operation.reload
			?.rollback()
			.catch((error: unknown) => this.#host.report(error))
			.finally(() => endReload(this.#host));
	}

	async #run(
		operation: ChildOperation,
		connection: Connection,
		frame: Extract<Frame, { t: "prepare" }>,
	): Promise<void> {
		const cancelled = (): ChordError =>
			new ChordError("aborted", "reload aborted by the server", { reason: "aborted" });
		try {
			operation.reload = await beginReload(this.#host, frame.plugins, frame.options, frame.codeVersion);
			if (operation.cancelled) throw cancelled();
			operation.state = "preparing";
			await operation.reload.prepare();
			if (operation.cancelled) throw cancelled();
			operation.state = "prepared";
			connection.send({ t: "vote", reload: frame.reload, report: operation.reload.summary() });
		} catch (error) {
			if (operation.reload !== undefined) {
				await operation.reload.rollback().catch((cleanup: unknown) => this.#host.report(cleanup));
				endReload(this.#host);
			}
			if (this.#operation === operation) this.#operation = undefined;
			if (!operation.cancelled) connection.send({ t: "vote", reload: frame.reload, error: toWireError(error) });
		}
	}
}

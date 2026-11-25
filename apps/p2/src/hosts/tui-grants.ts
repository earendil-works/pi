// Launcher grants (p2-tui-port.md section 3.1): permission for exactly one action instance, bound to the worker
// instance, the server origin, the session/conversation the worker named, and an expiry. Results of a grant that was
// cancelled (worker swap, navigation away, close) are dropped.
import { randomUUID } from "node:crypto";
import { isKeyRelease, type KeybindingsConfig, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { builtinKeybindings, isPrivileged, type KeyPlatform, resolvePrivilegedKeys } from "../tui/keybindings.ts";
import type { ConsentRequest, TrustedUi } from "./tui-trusted-ui.ts";

export type GrantTarget = { session: string; conversation: number };
export type Grant = {
	readonly id: string;
	readonly action: string;
	readonly kind: "K" | "C" | "gesture";
	readonly worker: object;
	readonly origin: string;
	readonly target: GrantTarget | undefined;
	readonly expires: number;
	/** Aborted when the grant is cancelled: uploads, downloads and editors stop and clean up. */
	readonly signal: AbortSignal;
};

/** What a launcher action may use. Worker data arrives through `ask`, bound to the grant. */
export type LauncherActionContext = {
	grant: Grant;
	ui: TrustedUi;
	origin: URL;
	/** Asks the worker that holds the grant for data (e.g. the text to copy); rejected once the grant is cancelled. */
	ask(kind: string, payload?: unknown): Promise<unknown>;
	/** Writes launcher output (e.g. OSC 52) straight to the terminal, bypassing the worker filter. */
	writeTerminal(data: string): void;
	/** Sends input to the granting worker as if typed (Ctrl+V's text paste). */
	sendInput(data: string): void;
	/** Lends the real terminal to a local program; worker IO stays suspended until `run` settles. */
	releaseTerminal<T>(run: () => Promise<T>): Promise<T>;
};
export type LauncherAction =
	| {
			/** K: fired by the visitor's own key for privileged id `key` (section 3.1), consumed before the worker. */
			kind: "K";
			key: string;
			run(context: LauncherActionContext): Promise<void>;
	  }
	| {
			/**
			 * Gesture: requested by the worker, but accepted only within a short time after the launcher itself saw the
			 * matching user gesture in the raw input (section 3.1 rule 5: the mouse release ending a selection). One use.
			 */
			kind: "gesture";
			gesture: "selection";
			accept(payload: unknown): boolean;
			run(payload: unknown, context: LauncherActionContext): Promise<unknown>;
	  }
	| {
			/**
			 * C: requested by the worker; runs only after local confirmation of exactly what `consent` shows, unless
			 * `consent` answers `ask: false` (requests the server could make happen by itself).
			 */
			kind: "C";
			/** Validates the payload and describes it; undefined denies without asking. */
			consent(
				payload: unknown,
				context: { origin: URL; target: GrantTarget | undefined },
			): ConsentRequest | undefined;
			run(payload: unknown, context: LauncherActionContext): Promise<unknown>;
	  };

const GRANT_TTL_MS = 10 * 60_000;

export class Grants {
	private grants = new Map<string, Grant & { abort: AbortController }>();
	private readonly origin: string;
	constructor(origin: string) {
		this.origin = origin;
	}
	create(action: string, kind: Grant["kind"], worker: object, target: GrantTarget | undefined, ttlMs = GRANT_TTL_MS) {
		const abort = new AbortController();
		const grant = {
			id: randomUUID(),
			action,
			kind,
			worker,
			origin: this.origin,
			target,
			expires: Date.now() + ttlMs,
			signal: abort.signal,
			abort,
		};
		this.grants.set(grant.id, grant);
		return grant;
	}
	/** The grant, if it still holds for this worker (and action); expired grants are cancelled on lookup. */
	valid(id: string, worker: object, action?: string): Grant | undefined {
		const grant = this.grants.get(id);
		if (!grant) return undefined;
		if (grant.expires < Date.now()) {
			this.cancel(id);
			return undefined;
		}
		return grant.worker === worker && (action === undefined || grant.action === action) ? grant : undefined;
	}
	/** Done: the grant cannot be used again. */
	complete(id: string): void {
		this.grants.delete(id);
	}
	cancel(id: string): void {
		const grant = this.grants.get(id);
		if (!grant) return;
		this.grants.delete(id);
		grant.abort.abort(new Error("Grant cancelled"));
	}
	/** Worker swap or crash: nothing it was granted survives. */
	cancelWorker(worker: object): void {
		for (const grant of [...this.grants.values()]) if (grant.worker === worker) this.cancel(grant.id);
	}
	/** The worker reports another session/conversation: grants for the old target end. */
	navigate(worker: object, target: GrantTarget | undefined): void {
		for (const grant of [...this.grants.values()])
			if (
				grant.worker === worker &&
				grant.target !== undefined &&
				(grant.target.session !== target?.session || grant.target.conversation !== target.conversation)
			)
				this.cancel(grant.id);
	}
	cancelAll(): void {
		for (const id of [...this.grants.keys()]) this.cancel(id);
	}
	get size(): number {
		return this.grants.size;
	}
}

/** Validates a worker's `navigation` report. */
export function parseTarget(value: unknown): GrantTarget | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { session, conversation } = value as Record<string, unknown>;
	return typeof session === "string" &&
		/^[\w-]{1,128}$/.test(session) &&
		typeof conversation === "number" &&
		Number.isInteger(conversation) &&
		conversation > 0
		? { session, conversation }
		: undefined;
}

/**
 * The launcher's own keymap for privileged ids (section 3.1 rules 1-3), from the visitor's local bindings only:
 * never from the server or the worker. A key is intercepted only when an action for its id is registered.
 */
export class PrivilegedKeys {
	private keys: [id: string, keys: KeyId[]][] = [];
	constructor(local: KeybindingsConfig, platform: KeyPlatform, actions: readonly string[]) {
		const resolved = resolvePrivilegedKeys(builtinKeybindings(platform), local).keys;
		this.keys = Object.entries(resolved).filter(([id]) => isPrivileged(id) && actions.includes(id));
	}
	/** The privileged id this input is a key of (press or repeat; releases match too, so they are consumed). */
	match(data: string): { id: string; release: boolean } | undefined {
		for (const [id, keys] of this.keys)
			if (keys.some((key) => matchesKey(data, key))) return { id, release: isKeyRelease(data) };
		return undefined;
	}
}

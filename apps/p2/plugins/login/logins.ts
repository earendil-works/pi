import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { LockedFile, processLogs } from "@p2/app/v1/node";
import type { Resources } from "../models/contract.ts";
import type { LoginEvent, LoginPrompt, LoginState } from "./contract.ts";

type PendingPrompt = { prompt: LoginPrompt; resolve: (value: string) => void };
type Attempt = {
	id: string;
	owner: string;
	providerId: string;
	remote: boolean;
	controller: AbortController;
	prompts: Map<string, PendingPrompt>;
	done: Promise<void>;
};

/** The current login (one at a time) and the principal key of the owner that started it. */
export type LoginsState = { readonly login: LoginState | null; readonly owner: string | null };

/**
 * Provider logins (provider-owned api-key and OAuth flows over the shared credentials), one at a time. The flow runs
 * here, outside Chord; its state changes synchronously with each event, and listeners hear of every change (the
 * server's `LoginService` follows it).
 */
export class Logins {
	private readonly resources: Resources;
	private readonly lifetime = new AbortController();
	private readonly device: LockedFile;
	private readonly listeners = new Set<() => void>();
	private active: Attempt | undefined;
	private current: LoginsState = { login: null, owner: null };

	constructor(resources: Resources) {
		this.resources = resources;
		this.device = new LockedFile(join(resources.directory, "device.json"));
	}

	get state(): LoginsState {
		return this.current;
	}

	/** `listener` hears of every change of `state`; the result stops it. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The current login, if `owner` started it. */
	private mine(owner: string): LoginState | null {
		return this.current.owner === owner ? this.current.login : null;
	}

	start(owner: string, providerId: string, authType: AuthType, remote = false): string {
		if (this.lifetime.signal.aborted) throw new Error("Server is shutting down");
		if (this.active)
			throw new Error(
				this.active.owner === owner
					? "A provider login is already in progress; cancel it first"
					: "Another owner device is signing in to a provider; try again when it has finished",
			);
		const provider = this.resources.models.getProvider(providerId);
		if (!(authType === "oauth" ? provider?.auth.oauth?.login : provider?.auth.apiKey?.login))
			throw new Error("Provider does not support this login method");
		const attempt: Attempt = {
			id: randomUUID(),
			owner,
			providerId,
			remote,
			controller: new AbortController(),
			prompts: new Map(),
			done: Promise.resolve(),
		};
		this.active = attempt;
		this.emit(owner, { type: "started", attemptId: attempt.id, providerId, authType });
		attempt.done = this.run(attempt, authType);
		return attempt.id;
	}

	private async deviceId(signal: AbortSignal): Promise<string> {
		return this.device.withLockAsync(
			async (content) => {
				let data: unknown;
				try {
					data = JSON.parse(content ?? "{}");
				} catch {
					throw new Error("Invalid device identity file");
				}
				if (!data || typeof data !== "object" || Array.isArray(data))
					throw new Error("Invalid device identity file");
				if ("id" in data && typeof data.id === "string" && data.id) return { result: data.id };
				const id = randomUUID();
				return { result: id, next: JSON.stringify({ id }) };
			},
			{ signal },
		);
	}

	private prompt(attempt: Attempt, input: AuthPrompt, whole: AbortSignal): Promise<string> {
		const signal = input.signal ? AbortSignal.any([whole, input.signal]) : whole;
		// pi-ai's method selectors use device_code (Codex) or device-code (Radius).
		// Other selectors (accounts, organizations, etc.) still require the owner's answer.
		if (attempt.remote && input.type === "select") {
			const deviceCode = input.options.find((option) => /^device[-_]code$/.test(option.id));
			if (deviceCode) {
				if (signal.aborted) return Promise.reject(signal.reason);
				this.emit(attempt.owner, {
					type: "notice",
					attemptId: attempt.id,
					event: { type: "info", message: "Using device-code login on this remote connection." },
				});
				return Promise.resolve(deviceCode.id);
			}
		}
		const { signal: _signal, ...description } = input;
		const id = randomUUID();
		const prompt: LoginPrompt = { ...description, id };
		return new Promise<string>((resolve, reject) => {
			const cleanup = () => {
				signal.removeEventListener("abort", abort);
				attempt.prompts.delete(id);
				this.emit(attempt.owner, { type: "promptClosed", attemptId: attempt.id, promptId: id });
			};
			const abort = () => {
				cleanup();
				reject(signal.reason);
			};
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			attempt.prompts.set(id, {
				prompt,
				resolve: (value) => {
					cleanup();
					resolve(value);
				},
			});
			signal.addEventListener("abort", abort, { once: true });
			this.emit(attempt.owner, { type: "prompt", attemptId: attempt.id, prompt });
		});
	}

	private async run(attempt: Attempt, type: AuthType): Promise<void> {
		const deadline = AbortSignal.timeout(600_000);
		const signal = AbortSignal.any([attempt.controller.signal, this.lifetime.signal, deadline]);
		let committed = false;
		try {
			// Provider-owned login/refresh only. Never return the credential to a client.
			const deviceId = await this.deviceId(signal);
			await this.resources.models.login(
				attempt.providerId,
				type,
				{
					signal,
					prompt: (prompt) => this.prompt(attempt, prompt, signal),
					notify: (event) => {
						if (!signal.aborted) this.emit(attempt.owner, { type: "notice", attemptId: attempt.id, event });
					},
				},
				{ getDeviceId: () => deviceId },
			);
			committed = true;
			this.resources.publish();
			let message: string | undefined;
			try {
				await this.resources.refreshModels(attempt.providerId, signal);
			} catch {
				message = "Signed in. Model-list refresh did not complete; use Refresh models to retry.";
			}
			this.emit(attempt.owner, {
				type: "finished",
				attemptId: attempt.id,
				status: "success",
				...(message ? { message } : {}),
			});
		} catch {
			this.emit(attempt.owner, {
				type: "finished",
				attemptId: attempt.id,
				status: committed ? "success" : signal.aborted ? "cancelled" : "error",
				message: committed
					? "Signed in; resource refresh did not complete."
					: signal.aborted
						? "Login cancelled."
						: "Provider login failed. Check the provider configuration and try again.",
			});
		} finally {
			attempt.controller.abort(); // Withdraw leftover/manual prompts after callback success.
			if (this.active === attempt) this.active = undefined;
		}
	}

	private owned(owner: string, id: string): Attempt {
		if (!this.active || this.active.id !== id || this.active.owner !== owner)
			throw new Error("Login attempt is no longer active for this connection");
		return this.active;
	}

	/** Answers the prompt (closed at once); secrets and pasted codes are redacted from the logs first. */
	answer(owner: string, attemptId: string, promptId: string, value: string): void {
		const attempt = this.owned(owner, attemptId);
		const pending = attempt.prompts.get(promptId);
		if (!pending) throw new Error("Login prompt is no longer active");
		if (pending.prompt.type === "select" && !pending.prompt.options.some((option) => option.id === value))
			throw new Error("Select one of the listed options");
		if (pending.prompt.type === "secret" || pending.prompt.type === "manual_code")
			processLogs.redactor.addSecret(value);
		pending.resolve(value);
	}

	/** Cancels the login; resolves once it finished (its state shows "cancelled", or what it reached first). */
	async cancel(owner: string, attemptId: string): Promise<void> {
		const attempt = this.owned(owner, attemptId);
		attempt.controller.abort();
		await attempt.done;
	}

	/** Clears `owner`'s finished login `attemptId` from the state. */
	dismiss(owner: string, attemptId: string): void {
		const login = this.mine(owner);
		if (login?.attemptId !== attemptId || login.status === "working") return;
		this.current = { ...this.current, login: null };
		this.changed();
	}

	/** Its owner left (closed the sheet everywhere, or disconnected): end its unfinished login, nobody else's. */
	disconnect(owner: string): void {
		if (this.active?.owner === owner) this.active.controller.abort();
	}

	async logout(providerId: string): Promise<void> {
		if (this.active) throw new Error("Cancel the active login before removing credentials");
		await this.resources.models.logout(providerId, { signal: this.lifetime.signal });
		await this.resources.modelStore.delete(providerId, { signal: this.lifetime.signal });
		await this.resources.reload();
		this.resources.publish();
	}

	async refresh(providerId: string): Promise<void> {
		await this.resources.refreshModels(providerId, this.lifetime.signal);
	}

	/** Applies `event` of `owner`'s login to the state, redacting the codes and URLs it shows from the logs. */
	private emit(owner: string, event: LoginEvent): void {
		if (event.type === "notice" && event.event.type === "device_code")
			processLogs.redactor.addSecret(event.event.userCode);
		if (event.type === "notice" && event.event.type === "auth_url") processLogs.redactor.addSecret(event.event.url);
		this.current = {
			owner: event.type === "started" ? owner : this.current.owner,
			login: reduce(this.current.login, event),
		};
		this.changed();
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	async close(): Promise<void> {
		this.lifetime.abort();
		this.active?.controller.abort();
		await this.active?.done;
		await this.device.close();
	}
}

/** The next state of the current login after `event`. */
function reduce(state: LoginState | null, event: LoginEvent): LoginState | null {
	if (event.type === "started")
		return {
			attemptId: event.attemptId,
			providerId: event.providerId,
			authType: event.authType,
			status: "working",
			prompt: null,
			notices: [],
		};
	if (state === null || state.attemptId !== event.attemptId) return state;
	switch (event.type) {
		case "prompt":
			return { ...state, prompt: event.prompt };
		case "promptClosed":
			return state.prompt?.id === event.promptId ? { ...state, prompt: null } : state;
		case "notice":
			return { ...state, notices: [...state.notices, { id: state.notices.length, event: event.event }] };
		case "finished":
			return {
				...state,
				status: event.status,
				prompt: null,
				...(event.message === undefined ? {} : { message: event.message }),
			};
	}
}

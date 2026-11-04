import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";

describe("RuntimeCredentials", () => {
	test("runtime overrides mask stored credentials without persisting", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const credentials = new RuntimeCredentials(storage);

		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });

		credentials.removeRuntimeApiKey("anthropic");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });
	});

	test("enumeration merges overrides without exposing keys", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
		});
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		credentials.setRuntimeApiKey("openai", "other-runtime-key");

		expect(await credentials.list()).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
	});

	test("forwards operation signals to the persistent store", async () => {
		const controller = new AbortController();
		const received: AbortSignal[] = [];
		const storage: CredentialStore = {
			read: async (_providerId, options) => {
				received.push(options?.signal as AbortSignal);
				return undefined;
			},
			list: async (options) => {
				received.push(options?.signal as AbortSignal);
				return [];
			},
			modify: async (_providerId, _fn, options) => {
				received.push(options?.signal as AbortSignal);
				return undefined;
			},
			delete: async (_providerId, options) => {
				received.push(options?.signal as AbortSignal);
			},
		};
		const credentials = new RuntimeCredentials(storage);

		await credentials.read("anthropic", { signal: controller.signal });
		await credentials.list({ signal: controller.signal });
		await credentials.modify("anthropic", async () => undefined, { signal: controller.signal });
		await credentials.delete("anthropic", { signal: controller.signal });

		expect(received).toEqual([controller.signal, controller.signal, controller.signal, controller.signal]);
	});

	test("keeps a runtime override when persistent deletion is cancelled", async () => {
		const aborted = new Error("cancelled");
		aborted.name = "AbortError";
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const deleteSpy = vi.spyOn(storage, "delete").mockRejectedValueOnce(aborted);
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		await expect(credentials.delete("anthropic", { signal: new AbortController().signal })).rejects.toBe(aborted);
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
	});

	// #11692: shutdown waits for a started OAuth refresh so the rotated token is not lost.
	test("settled waits for started modifications, not for ones waiting on the lock", async () => {
		let releaseLock!: () => void;
		const lock = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		let lockHeld = false;
		const stored = new Map<string, Credential>();
		const storage: CredentialStore = {
			read: async (providerId) => stored.get(providerId),
			list: async () => [],
			modify: async (providerId, fn) => {
				// The first modification holds the lock until released; later ones wait for it.
				if (lockHeld) await lock;
				lockHeld = true;
				const next = await fn(stored.get(providerId));
				if (next) stored.set(providerId, next);
				return next;
			},
			delete: async () => {},
		};
		const credentials = new RuntimeCredentials(storage);

		let finishRefresh!: () => void;
		const refreshing = new Promise<void>((resolve) => {
			finishRefresh = resolve;
		});
		const started = credentials.modify("anthropic", async () => {
			await refreshing;
			return { type: "api_key", key: "rotated" };
		});
		const waiting = credentials.modify("openai", async () => ({ type: "api_key", key: "never-started" }));

		let settled = false;
		const settling = credentials.settled().then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);

		finishRefresh();
		await settling;
		expect(stored.get("anthropic")).toEqual({ type: "api_key", key: "rotated" });
		expect(stored.has("openai")).toBe(false);

		await started;
		releaseLock();
		await waiting;
	});

	test("settled resolves after a started modification fails", async () => {
		const storage = AuthStorage.inMemory();
		const credentials = new RuntimeCredentials(storage);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let failRefresh!: () => void;
		const refreshFailed = new Promise<void>((resolve) => {
			failRefresh = resolve;
		});
		const failed = credentials.modify("anthropic", async () => {
			markStarted();
			await refreshFailed;
			throw new Error("invalid_grant");
		});
		const rejected = expect(failed).rejects.toThrow("invalid_grant");

		await started;
		const settling = credentials.settled();
		failRefresh();
		await settling;
		await rejected;
	});

	test("delete clears both the override and persisted credential", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		await credentials.delete("anthropic");

		expect(await credentials.read("anthropic")).toBeUndefined();
		expect(await credentials.list()).toEqual([]);
	});
});

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Provider } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>): void {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	test("reads and resolves stored API-key credentials", async () => {
		const original = process.env.TEST_AUTH_STORAGE_KEY;
		process.env.TEST_AUTH_STORAGE_KEY = "environment-key";
		try {
			writeAuthJson({ anthropic: { type: "api_key", key: "$TEST_AUTH_STORAGE_KEY" } });
			const storage = AuthStorage.create(authJsonPath);
			expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "environment-key" });
		} finally {
			if (original === undefined) delete process.env.TEST_AUTH_STORAGE_KEY;
			else process.env.TEST_AUTH_STORAGE_KEY = original;
		}
	});

	test("resolves command-backed API-key credentials", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "!printf 'command-key'" } });
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "command-key" });
	});

	test("returns OAuth credentials unchanged", async () => {
		const credential = {
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
		const storage = AuthStorage.inMemory({ anthropic: credential });
		expect(await storage.read("anthropic")).toEqual(credential);
	});

	test("credential-scoped env takes precedence and remains inspectable", async () => {
		writeAuthJson({
			anthropic: {
				type: "api_key",
				key: "$SCOPED_KEY",
				env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
			},
		});
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.read("anthropic")).toMatchObject({
			key: "scoped-value",
			env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
		});
	});

	test("modify persists a credential while preserving unrelated external edits", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({
			anthropic: { type: "api_key", key: "old" },
			openai: { type: "api_key", key: "external" },
		});

		await storage.modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "new" },
			openai: { type: "api_key", key: "external" },
		});
	});

	test("modify with undefined leaves the current credential unchanged", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.modify("anthropic", async () => undefined)).toEqual({ type: "api_key", key: "stored" });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored" });
	});

	test("serializes concurrent modifications", async () => {
		writeAuthJson({});
		const first = AuthStorage.create(authJsonPath);
		const second = AuthStorage.create(authJsonPath);
		await Promise.all([
			first.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-key" })),
			second.modify("openai", async () => ({ type: "api_key", key: "openai-key" })),
		]);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
	});

	test("delete removes one credential while preserving others", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
			google: { type: "api_key", key: "external-key" },
		});
		await storage.delete("anthropic");
		await expect(storage.list()).resolves.toEqual([
			{ providerId: "openai", type: "api_key" },
			{ providerId: "google", type: "api_key" },
		]);
		expect(await storage.read("anthropic")).toBeUndefined();
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "openai-key" });
		expect(await storage.read("google")).toEqual({ type: "api_key", key: "external-key" });
	});

	test("in-memory storage implements the same credential-store behavior", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "initial" } });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "initial" });
		await storage.modify("anthropic", async () => ({ type: "api_key", key: "updated" }));
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "updated" });
		await storage.delete("anthropic");
		await expect(storage.list()).resolves.toEqual([]);
	});

	test("does not write after lock acquisition failure and recovers on retry", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		const lockSpy = vi.spyOn(lockfile, "lock").mockRejectedValueOnce(new Error("lock unavailable"));

		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow(
			"lock unavailable",
		);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
		});

		lockSpy.mockRestore();
		await storage.modify("openai", async () => ({ type: "api_key", key: "new" }));
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
			openai: { type: "api_key", key: "new" },
		});
	});

	test("surfaces a compromised OAuth refresh lock and allows a later retry", async () => {
		const providerId = "oauth-provider";
		writeAuthJson({
			[providerId]: {
				type: "oauth",
				access: "expired-access",
				refresh: "refresh-token",
				expires: 0,
			},
		});
		const storage = AuthStorage.create(authJsonPath);
		const provider: Provider = {
			id: providerId,
			name: "OAuth Provider",
			auth: {
				oauth: {
					name: "OAuth",
					login: async () => {
						throw new Error("not used");
					},
					refresh: async (credential) => ({
						...credential,
						access: "refreshed-access",
						expires: Date.now() + 60_000,
					}),
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			getModels: () => [],
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		};
		const models = createModels({ credentials: storage });
		models.setProvider(provider);

		const realLock = lockfile.lock.bind(lockfile);
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementationOnce(async (file, options) => {
			options?.onCompromised?.(new Error("lock compromised"));
			return realLock(file, options);
		});
		await expect(models.getAuth(providerId)).rejects.toMatchObject({ code: "auth" });

		lockSpy.mockRestore();
		await expect(models.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "refreshed-access" } });
	});

	test("does not overwrite malformed auth files", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		writeFileSync(authJsonPath, "{invalid-json", "utf8");
		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow();
		expect(readFileSync(authJsonPath, "utf8")).toBe("{invalid-json");
	});
});

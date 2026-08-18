import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import { createNodeSqliteFactory, type SqliteSessionMetadata, SqliteSessionRepository } from "../src/index.ts";
import { createTempDir, createUserMessage } from "./test-utils.ts";

function createRepository(root: string, databasePath: string, lease?: { ttlMs: number; heartbeatIntervalMs: number }) {
	const repository = new SqliteSessionRepository({
		env: new NodeExecutionEnv({ cwd: root }),
		sqlite: createNodeSqliteFactory(),
		databasePath,
		writerLease: lease,
	});
	return repository;
}

describe("SQLite session writer leases", () => {
	it("shares one write queue across repeated opens in one repository", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		await using repository = createRepository(root, databasePath);
		const session = await repository.create({ cwd: root, id: "session" });
		const reopened = await repository.open(await session.getMetadata());

		const [first, second] = await Promise.all([
			session.appendMessage(createUserMessage("first")),
			reopened.appendMessage(createUserMessage("second")),
		]);

		expect((await session.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([first, second]);
	});

	it.each([
		[{ ttlMs: 0, heartbeatIntervalMs: 1 }, "writerLease.ttlMs must be positive"],
		[
			{ ttlMs: 100, heartbeatIntervalMs: 100 },
			"writerLease.heartbeatIntervalMs must be positive and less than ttlMs",
		],
	])("rejects invalid lease timing %o", (writerLease, message) => {
		const root = createTempDir();
		expect(
			() =>
				new SqliteSessionRepository({
					env: new NodeExecutionEnv({ cwd: root }),
					sqlite: createNodeSqliteFactory(),
					databasePath: join(root, "sessions.sqlite"),
					writerLease,
				}),
		).toThrow(message);
	});

	it("lists complete metadata without acquiring active sessions' writer leases", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		await using writerRepository = createRepository(root, databasePath);
		await using readerRepository = createRepository(root, databasePath);
		const first = await writerRepository.create({
			cwd: root,
			id: "session-1",
			metadata: { profile: "reviewer" },
		});
		const second = await writerRepository.create({
			cwd: root,
			id: "session-2",
			parentSessionId: "session-1",
			metadata: { profile: "writer", name: "application-owned name" },
		});
		await first.setName("Review session");
		await second.setName("Write session");
		const [firstMetadata, secondMetadata] = await Promise.all([first.getMetadata(), second.getMetadata()]);
		expect(firstMetadata).toMatchObject({ name: "Review session", metadata: { profile: "reviewer" } });
		expect(secondMetadata).toMatchObject({
			name: "Write session",
			metadata: { profile: "writer", name: "application-owned name" },
		});
		const expected = [firstMetadata, secondMetadata];
		const sqlite = createNodeSqliteFactory();
		const inspection = await sqlite.open(databasePath);
		let leasesBefore: { session_id: string; owner_id: string; fence: number; expires_at_ms: number }[];
		try {
			leasesBefore = await inspection
				.prepare("SELECT session_id, owner_id, fence, expires_at_ms FROM writer_leases ORDER BY session_id")
				.all();
		} finally {
			await inspection.close();
		}

		const listed = await readerRepository.list({ cwd: root });

		expect([...listed].sort((left, right) => left.id.localeCompare(right.id))).toEqual(
			[...expected].sort((left, right) => left.id.localeCompare(right.id)),
		);
		const afterList = await sqlite.open(databasePath);
		try {
			expect(
				await afterList
					.prepare("SELECT session_id, owner_id, fence, expires_at_ms FROM writer_leases ORDER BY session_id")
					.all(),
			).toEqual(leasesBefore);
		} finally {
			await afterList.close();
		}
		await expect(readerRepository.open(expected[0]!)).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("already has an active writer"),
		});
	});

	it("rejects a second writer until the first session releases its claim", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		await using firstRepository = createRepository(root, databasePath);
		await using secondRepository = createRepository(root, databasePath);
		const first = await firstRepository.create({ cwd: root, id: "session-1" });
		const metadata = await first.getMetadata();

		await expect(secondRepository.open(metadata)).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("already has an active writer"),
		});

		await firstRepository.close();
		const second = await secondRepository.open(metadata);
		await expect(second.appendMessage(createUserMessage("new owner"))).resolves.toBeTypeOf("string");
	});

	it("fences a stale owner after an expired lease is acquired by another writer", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const lease = { ttlMs: 120_000, heartbeatIntervalMs: 60_000 };
		await using firstRepository = createRepository(root, databasePath, lease);
		await using secondRepository = createRepository(root, databasePath, lease);
		const first = await firstRepository.create({ cwd: root, id: "session-1" });
		const metadata = await first.getMetadata();
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("UPDATE writer_leases SET expires_at_ms = 0 WHERE session_id = ?").run(metadata.id);
		} finally {
			await db.close();
		}

		const second = await secondRepository.open(metadata);
		await expect(first.appendMessage(createUserMessage("stale owner"))).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("writer lease was lost"),
		});
		expect(await second.findEntries()).toEqual([]);

		const inspection = await sqlite.open(databasePath);
		let currentLease: { owner_id: string; fence: number } | undefined;
		try {
			currentLease = await inspection
				.prepare("SELECT owner_id, fence FROM writer_leases WHERE session_id = ?")
				.get<{ owner_id: string; fence: number }>(metadata.id);
			expect(currentLease?.fence).toBe(2);
		} finally {
			await inspection.close();
		}

		await firstRepository.close();
		const afterStaleClose = await sqlite.open(databasePath);
		try {
			expect(
				await afterStaleClose
					.prepare("SELECT owner_id, fence FROM writer_leases WHERE session_id = ?")
					.get(metadata.id),
			).toEqual(currentLease);
		} finally {
			await afterStaleClose.close();
		}
		await expect(second.appendMessage(createUserMessage("current owner"))).resolves.toBeTypeOf("string");
	});

	it("serializes lease-checked writes for sessions sharing one database connection", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		await using repository = createRepository(root, databasePath);
		const first = await repository.create({ cwd: root, id: "session-1" });
		const second = await repository.create({ cwd: root, id: "session-2" });

		await expect(
			Promise.all([
				first.appendMessage(createUserMessage("first")),
				second.appendMessage(createUserMessage("second")),
			]),
		).resolves.toHaveLength(2);
	});

	it("renews an idle writer lease with a heartbeat", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		await using repository = createRepository(root, databasePath, { ttlMs: 30_000, heartbeatIntervalMs: 10_000 });
		const session = await repository.create({ cwd: root, id: "session-1" });
		const metadata = (await session.getMetadata()) as SqliteSessionMetadata;
		const sqlite = createNodeSqliteFactory();

		const readExpiry = async (): Promise<number | undefined> => {
			const db = await sqlite.open(databasePath);
			try {
				return (
					await db
						.prepare("SELECT expires_at_ms FROM writer_leases WHERE session_id = ?")
						.get<{ expires_at_ms: number }>(metadata.id)
				)?.expires_at_ms;
			} finally {
				await db.close();
			}
		};

		const initialExpiry = await readExpiry();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await readExpiry()).toBe((initialExpiry ?? 0) + 10_000);
	});
});

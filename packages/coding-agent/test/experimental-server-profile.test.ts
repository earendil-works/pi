import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireServerProfile } from "../src/experimental/server.ts";

const directories = new Set<string>();
const FIRST_SERVER_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_SERVER_ID = "00000000-0000-4000-8000-000000000002";

async function makeDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "psp-"));
	directories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("experimental server profile", () => {
	test("serializes launchers and preserves the server identity", async () => {
		const directory = await makeDirectory();
		const first = await acquireServerProfile(directory);
		let secondAcquired = false;
		const pendingSecond = acquireServerProfile(directory).then((profile) => {
			secondAcquired = true;
			return profile;
		});

		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(secondAcquired).toBe(false);
		await first.release();

		const second = await pendingSecond;
		expect(secondAcquired).toBe(true);
		expect(second.serverId).toBe(first.serverId);
		expect((await readFile(join(directory, "default-server-id"), "utf8")).trim()).toBe(first.serverId);
		await second.release();
	});

	test("does not serialize different server IDs in one directory", async () => {
		const directory = await makeDirectory();
		const [first, second] = await Promise.all([
			acquireServerProfile(directory, FIRST_SERVER_ID),
			acquireServerProfile(directory, SECOND_SERVER_ID),
		]);
		expect(first.serverId).toBe(FIRST_SERVER_ID);
		expect(second.serverId).toBe(SECOND_SERVER_ID);
		expect((await readdir(directory)).sort()).toEqual([
			`launcher-${FIRST_SERVER_ID}.lock`,
			`launcher-${SECOND_SERVER_ID}.lock`,
		]);
		await Promise.all([first.release(), second.release()]);
	});

	test("does not share the default identity across server directories", async () => {
		const firstDirectory = await makeDirectory();
		const secondDirectory = await makeDirectory();

		const [first, second] = await Promise.all([
			acquireServerProfile(firstDirectory),
			acquireServerProfile(secondDirectory),
		]);
		expect(first.serverId).not.toBe(second.serverId);
		await Promise.all([first.release(), second.release()]);
	});

	test("rejects a corrupt default identity", async () => {
		const directory = await makeDirectory();
		await writeFile(join(directory, "default-server-id"), "invalid\n");

		await expect(acquireServerProfile(directory)).rejects.toThrow(/Invalid default experimental server identity/);
	});

	test("rejects an invalid explicit server ID", async () => {
		const directory = await makeDirectory();
		await expect(acquireServerProfile(directory, "invalid")).rejects.toThrow("Invalid experimental server ID");
	});
});

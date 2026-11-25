// Radius's Chord sync adapter: request shape and terminal conflict mapping.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SYNC_PROTOCOL } from "@earendil-works/chord/sync";
import { isTerminalSyncError, RadiusSyncRemote } from "../../plugins/backup/radius-remote.ts";
import { TEST } from "./helpers.ts";

const SERVER = "01234567-89ab-4def-8123-456789abcdef";
const SESSION = "6f1c2b0e-3d4a-4b5c-8d6e-7f8091a2b3c4";

async function* body() {
	yield new Uint8Array([1, 2, 3]);
}

function remote(response: Response, requests: Request[] = []): RadiusSyncRemote {
	return new RadiusSyncRemote(
		async () => ({ gateway: "https://radius.example", serverId: SERVER, token: "radius-token" }),
		async (input, init) => {
			requests.push(new Request(input, init));
			return response;
		},
	);
}

/** What `promise` rejects with; fails the test when it resolves. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

function conflict(code: string, details: Record<string, unknown>): Response {
	return Response.json({ error: { message: code, code, details } }, { status: 409 });
}

describe("Radius sync remote", () => {
	it("streams the body: a piece is taken only as the request reads, never the whole body first", async () => {
		let produced = 0;
		async function* pieces() {
			for (let index = 0; index < 8; index++) {
				produced++;
				yield new Uint8Array([index]);
			}
		}
		// How many pieces had been produced each time the request read one.
		const producedAtRead: number[] = [];
		const result = await new RadiusSyncRemote(
			async () => ({ gateway: "https://radius.example", serverId: SERVER, token: "radius-token" }),
			async (input, init) => {
				const reader = new Request(input, init).body!.getReader();
				for (let read = await reader.read(); !read.done; read = await reader.read()) producedAtRead.push(produced);
				return Response.json({ created: true }, { status: 201 });
			},
		).putBatch(SESSION, 0, 8, SERVER, pieces(), TEST);
		assert.deepEqual(result, { type: "created" });
		assert.equal(producedAtRead.length, 8);
		// The producer is at most one piece ahead of the request (none buffered up front).
		assert.ok(
			producedAtRead.every((count, read) => count <= read + 2),
			`pieces produced at each read: ${producedAtRead.join(", ")}`,
		);
	});

	it("uploads an initial archive with the authenticated server path", async () => {
		const requests: Request[] = [];
		const result = await remote(Response.json({ created: true }, { status: 201 }), requests).putBatch(
			SESSION,
			0,
			4,
			"ignored-device",
			body(),
			TEST,
			{ archive: true },
		);
		assert.deepEqual(result, { type: "created" });
		assert.equal(requests.length, 1);
		const request = requests[0]!;
		assert.equal(
			request.url,
			`https://radius.example/v1/servers/${SERVER}/sync/sessions/${SESSION}/batches/0?to=4&archive=1`,
		);
		assert.equal(request.headers.get("authorization"), "Bearer radius-token");
		assert.equal(request.headers.get("pi-sync-protocol"), String(SYNC_PROTOCOL));
		assert.deepEqual(new Uint8Array(await request.arrayBuffer()), new Uint8Array([1, 2, 3]));
	});

	it("returns Chord's occupied-slot and divergence results", async () => {
		assert.deepEqual(
			await remote(conflict("slot_taken", { to: 4, device: SERVER })).putBatch(SESSION, 0, 4, SERVER, body(), TEST),
			{ type: "exists", to: 4, device: SERVER },
		);
		assert.deepEqual(await remote(conflict("not_head", { head: 7 })).putBatch(SESSION, 4, 5, SERVER, body(), TEST), {
			type: "not_head",
			head: 7,
		});
	});

	it("maps Radius integrity conflicts to terminal Chord divergence", async () => {
		for (const [code, details] of [
			["slot_content_mismatch", { to: 4, device: SERVER }],
			["next_id_regression", { head: 4, nextId: 9 }],
			["legacy_session_history", { head: 4 }],
		] as const) {
			assert.deepEqual(await remote(conflict(code, details)).putBatch(SESSION, 0, 4, SERVER, body(), TEST), {
				type: "not_head",
				head: 4,
			});
		}
	});

	it("sends the protocol version on reads and description writes too", async () => {
		const requests: Request[] = [];
		await remote(Response.json({ batches: [], snapshots: [] }), requests).list(SESSION, TEST);
		await remote(new Response(null, { status: 204 }), requests).putMeta(SESSION, { title: "t" }, TEST);
		assert.deepEqual(
			requests.map((request) => request.headers.get("pi-sync-protocol")),
			[String(SYNC_PROTOCOL), String(SYNC_PROTOCOL)],
		);
	});

	it("stops for good when a session needs a newer protocol", async () => {
		const tooOld = () => conflict("protocol_too_old", { minProtocol: SYNC_PROTOCOL + 1 });
		const upload = remote(tooOld()).putBatch(SESSION, 0, 1, SERVER, body(), TEST);
		assert.equal(isTerminalSyncError(await failureOf(upload)), true);
		const described = remote(tooOld()).putMeta(SESSION, { title: "t" }, TEST);
		assert.equal(isTerminalSyncError(await failureOf(described)), true);
		// Another conflict Radius may add later is retried, not taken for a refusal.
		const unknown = remote(conflict("unknown_conflict", {})).putBatch(SESSION, 0, 1, SERVER, body(), TEST);
		assert.equal(isTerminalSyncError(await failureOf(unknown)), false);
	});

	it("still rejects an unknown Radius conflict", async () => {
		await assert.rejects(
			remote(conflict("unknown_conflict", {})).putBatch(SESSION, 0, 1, SERVER, body(), TEST),
			/Radius sync could not upload a batch: 409 unknown_conflict/,
		);
	});
});

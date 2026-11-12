// Radius's Chord sync adapter: request shape and terminal conflict mapping.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RadiusSyncRemote } from "../../plugins/sync/radius-remote.ts";
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

function conflict(code: string, details: Record<string, unknown>): Response {
	return Response.json({ error: { message: code, code, details } }, { status: 409 });
}

describe("Radius sync remote", () => {
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

	it("still rejects an unknown Radius conflict", async () => {
		await assert.rejects(
			remote(conflict("unknown_conflict", {})).putBatch(SESSION, 0, 1, SERVER, body(), TEST),
			/Radius sync could not upload a batch: 409 unknown_conflict/,
		);
	});
});

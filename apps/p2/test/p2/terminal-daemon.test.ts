import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteError } from "@earendil-works/pi-env";
import { requireTerminalSupport } from "../../plugins/terminals/daemon.ts";

test("terminal capability probe validates PTY support without starting a shell", async () => {
	await requireTerminalSupport({
		request: async (op, json) => {
			assert.equal(op, "pty");
			assert.deepEqual(json, { cwd: "", cols: 0, rows: 0 });
			throw new RemoteError({ code: "EINVAL", message: "cols must be between 1 and 4096" });
		},
	});
});

test("terminal capability probe rejects released daemons that predate PTY support", async () => {
	// The released 1.1.0 daemon and the source build have the same version, but different operations.
	const error = new RemoteError({ code: "EINVAL", message: "unknown operation pty" });
	await assert.rejects(
		requireTerminalSupport({
			request: async () => {
				throw error;
			},
		}),
		(caught) => caught === error,
	);
});

test("terminal capability probe does not mistake other failures or successful invalid requests for support", async () => {
	const error = new RemoteError({ code: "spawn_error", message: "daemon unavailable" });
	await assert.rejects(
		requireTerminalSupport({
			request: async () => {
				throw error;
			},
		}),
		(caught) => caught === error,
	);
	await assert.rejects(
		requireTerminalSupport({ request: async () => ({ json: {}, payload: new Uint8Array(), session: 1 }) }),
		/accepted an invalid terminal size/,
	);
});

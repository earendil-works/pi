import { describe, expect, it } from "vitest";

// Off by default, zero cost when off: importing supervisor code must not start a server or bind a port.
describe("off by default", () => {
	it("lazy: no server starts on import", async () => {
		const mod = await import("../src/supervisor.ts");
		// No listen() called; constructing a Supervisor does not bind.
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "orch-off-"));
		try {
			const sup = mod.createSupervisor({ config: { dbPath: join(dir, "off.db"), port: 0 } });
			// supervisorUrl is 127.0.0.1:0 until listen() (0 = ephemeral, not yet bound).
			expect(sup.supervisorUrl.endsWith(":0")).toBe(true);
			sup.store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@earendil-works/pi-orchestra-core";
import { describe, expect, it } from "vitest";
import { renderStatus } from "../src/index.ts";

describe("status view", () => {
	it("renders agents/tasks/leases from DB", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-cli-"));
		const store = new Store({ path: join(dir, "c.db") });
		try {
			const a = store.createAgent({ name: "ada", role: "lead" });
			store.createTask({ title: "plan", spec: "split", ownerAgentId: a.id });
			const out = renderStatus(store);
			expect(out).toContain("ada");
			expect(out).toContain("plan");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

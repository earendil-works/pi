import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import { TodoStore } from "../src/todos/todo-store.js";
import { TodoOverlayComponent } from "../src/tui/todo-overlay.js";

describe("TodoOverlayComponent", () => {
	it("renders grouped sections", async () => {
		initTheme("dark");
		const dir = await mkdtemp(join(tmpdir(), "mu-todo-overlay-"));
		const store = new TodoStore({ rootDir: dir, now: () => Date.parse("2026-02-08T02:00:00.000Z") });
		const who = { sessionId: "s1", runId: "r1" };

		const a = await store.create({ title: "Assigned", claim: true, who });
		await store.create({ title: "Open", who });
		await store.update(a.frontmatter.id, { status: "in_progress", who });
		const done = await store.create({ title: "Done", who });
		await store.update(done.frontmatter.id, { status: "done", who });

		const overlay = new TodoOverlayComponent({
			tui: { requestRender: () => undefined },
			store,
			who,
			onCancel: () => undefined,
		});
		await overlay.reload();
		overlay.showList();

		const lines = overlay.render(80).join("\n");
		expect(lines).toContain("Assigned to me");
		expect(lines).toContain("Open / unassigned");
		expect(lines).toContain("Done / cancelled");
		expect(lines).toContain("Assigned");
		expect(lines).toContain("Open");
		expect(lines).toContain("Done");
	});
});

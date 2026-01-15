import { describe, expect, it } from "vitest";
import { resetTodosForTest, todowriteTool } from "../src/tools/todowrite.js";
import { stripSystemReminderTagsForDisplay } from "../src/utils/system-reminder.js";

describe("TodoWrite system_reminder behavior", () => {
	it("appends hidden system_reminder when active items exist", async () => {
		resetTodosForTest();

		const result = await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Do the thing", status: "in_progress", priority: "high" },
					{ content: "Then do the other thing", status: "pending" },
				],
			},
			undefined,
			undefined,
		);

		const text = result.content.find((c) => c.type === "text")?.text;
		expect(text).toBeTruthy();

		expect(text).toContain("Do the thing");
		expect(text).toContain("Then do the other thing");
		expect(text).toContain("<system_reminder");
		expect(text).toContain("</system_reminder>");

		// Reminder should come after the rendered list.
		expect(text?.indexOf("</system_reminder>")).toBeGreaterThan(text?.indexOf("Then do the other thing") ?? -1);

		// UI/display layer should not show the reminder.
		const display = stripSystemReminderTagsForDisplay(text ?? "");
		expect(display).toContain("Do the thing");
		expect(display).toContain("Then do the other thing");
		expect(display).not.toContain("system_reminder");
	});

	it("does not append system_reminder when no active items exist", async () => {
		resetTodosForTest();

		const result = await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Done", status: "completed" },
					{ content: "Dropped", status: "cancelled" },
				],
			},
			undefined,
			undefined,
		);

		const text = result.content.find((c) => c.type === "text")?.text;
		expect(text).toBeTruthy();
		expect(text).toContain("Done");
		expect(text).toContain("Dropped");
		expect(text).not.toContain("system_reminder");
	});
});

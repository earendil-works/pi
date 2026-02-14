import { RenderCacheContainer } from "@kennyfrc/mu-tui";
import { describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

initTheme("dark");

class CountingUserMessageComponent extends UserMessageComponent {
	public renders = 0;

	override render(width: number): string[] {
		this.renders++;
		return super.render(width);
	}
}

class CountingToolExecutionComponent extends ToolExecutionComponent {
	public renders = 0;

	override render(width: number): string[] {
		this.renders++;
		return super.render(width);
	}
}

describe("RenderCacheContainer integration (coding-agent components)", () => {
	it("caches stable user message components (no re-render when width/revision unchanged)", () => {
		const c = new RenderCacheContainer();
		const msg = new CountingUserMessageComponent("hello", true);
		c.addChild(msg);

		c.render(80);
		c.render(80);

		expect(msg.renders).toBe(1);
	});

	it("re-renders tool execution components when they change, then caches again", () => {
		const c = new RenderCacheContainer();
		const tool = new CountingToolExecutionComponent("bash", { command: "echo hi" });
		c.addChild(tool);

		c.render(80);
		expect(tool.renders).toBe(1);

		tool.appendOutput("line1\n");
		c.render(80);
		expect(tool.renders).toBe(2);

		// No changes: should reuse cached lines.
		c.render(80);
		expect(tool.renders).toBe(2);
	});
});

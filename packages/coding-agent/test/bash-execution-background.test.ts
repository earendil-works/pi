import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createTuiStub(): any {
	return {
		terminal: {
			columns: 120,
			rows: 24,
		},
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
}

describe("BashExecutionComponent backgrounding", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows backgrounded state without the cancel hint and still completes later", () => {
		const component = new BashExecutionComponent("sleep 10", createTuiStub());

		component.setBackgrounded();

		const backgrounded = stripAnsi(component.render(120).join("\n"));
		expect(backgrounded).toContain("Running in background");
		expect(backgrounded).not.toContain("to cancel");

		component.appendOutput("done\n");
		component.setComplete(0, false);

		const completed = stripAnsi(component.render(120).join("\n"));
		expect(completed).toContain("done");
		expect(completed).not.toContain("Running in background");
	});
});

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickCommandsBar } from "./QuickCommandsBar";
import type { QuickCommand } from "../../lib/api";

function renderBar(props: Partial<React.ComponentProps<typeof QuickCommandsBar>> = {}) {
	const onInsert = vi.fn();
	const onSave = vi.fn().mockResolvedValue(undefined);
	const onOpenManager = vi.fn();
	const commands: QuickCommand[] = props.commands ?? [
		{ name: "review", description: "Code review", prompt: "Review: $ARG" },
		{ name: "commit", prompt: "Make a commit" },
	];
	const utils = render(
		<QuickCommandsBar
			commands={commands}
			onInsert={props.onInsert ?? onInsert}
			onSave={props.onSave ?? onSave}
			onOpenManager={props.onOpenManager ?? onOpenManager}
		/>,
	);
	return { ...utils, onInsert, onSave, onOpenManager };
}

describe("QuickCommandsBar", () => {
	it("renders one chip per command with /name", () => {
		renderBar();
		expect(screen.getByText("/review")).toBeTruthy();
		expect(screen.getByText("/commit")).toBeTruthy();
	});

	it("clicking a chip calls onInsert with the command name", () => {
		const { onInsert } = renderBar();
		fireEvent.click(screen.getByText("/review"));
		expect(onInsert).toHaveBeenCalledWith("review");
	});

	it("clicking Manage calls onOpenManager", () => {
		const { onOpenManager } = renderBar();
		fireEvent.click(screen.getByText("Manage"));
		expect(onOpenManager).toHaveBeenCalled();
	});

	it("shows empty-state copy when no commands", () => {
		renderBar({ commands: [] });
		expect(screen.getByText(/No quick commands yet/)).toBeTruthy();
	});

	it("Add button opens inline row with name + prompt inputs + Save button", () => {
		renderBar();
		fireEvent.click(screen.getByLabelText("Add quick command"));
		expect(screen.getByLabelText("Command name")).toBeTruthy();
		expect(screen.getByLabelText("Command prompt")).toBeTruthy();
		expect(screen.getByText("Save")).toBeTruthy();
	});

	it("Save button is disabled when name or prompt is empty", () => {
		renderBar();
		fireEvent.click(screen.getByLabelText("Add quick command"));
		const saveBtn = screen.getByText("Save");
		expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
	});

	it("Save button is disabled when name collides with reserved word", () => {
		renderBar();
		fireEvent.click(screen.getByLabelText("Add quick command"));
		fireEvent.change(screen.getByLabelText("Command name"), { target: { value: "compact" } });
		fireEvent.change(screen.getByLabelText("Command prompt"), { target: { value: "x" } });
		const saveBtn = screen.getByText("Save");
		expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
	});

	it("filling valid name + prompt and clicking Save calls onSave with appended list", async () => {
		const { onSave } = renderBar();
		fireEvent.click(screen.getByLabelText("Add quick command"));
		fireEvent.change(screen.getByLabelText("Command name"), { target: { value: "lint" } });
		fireEvent.change(screen.getByLabelText("Command prompt"), { target: { value: "Run linter" } });
		fireEvent.click(screen.getByText("Save"));
		expect(onSave).toHaveBeenCalledTimes(1);
		const called = onSave.mock.calls[0][0] as QuickCommand[];
		expect(called).toHaveLength(3);
		expect(called[2]).toEqual({ name: "lint", description: undefined, prompt: "Run linter" });
	});

	it("Cancel button closes the inline row without saving", () => {
		const { onSave } = renderBar();
		fireEvent.click(screen.getByLabelText("Add quick command"));
		fireEvent.click(screen.getByText("Cancel"));
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("Command name")).toBeNull();
	});
});
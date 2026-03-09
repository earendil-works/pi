import type { SlashCommand } from "@kennyfrc/mu-tui";
import { describe, expect, it, vi } from "vitest";
import {
	getSlashCommandQueueKind,
	SlashCommandOverlayComponent,
	type SlashCommandSelectTrigger,
} from "../src/tui/slash-command-overlay.js";

describe("SlashCommandOverlayComponent", () => {
	const commands: SlashCommand[] = [{ name: "queue", description: "Select queue mode" }];

	function createOverlay(onSelect?: (command: SlashCommand, trigger: SlashCommandSelectTrigger) => void) {
		return new SlashCommandOverlayComponent({
			getCommands: () => commands,
			onSelect: onSelect ?? vi.fn(),
			onCancel: vi.fn(),
		});
	}

	it("passes an enter trigger when the selected slash command is confirmed with Enter", () => {
		const onSelect = vi.fn();
		const overlay = createOverlay(onSelect);

		overlay.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(commands[0], "enter");
		expect(getSlashCommandQueueKind("enter")).toBe("next");
	});

	it("passes a tab trigger when the selected slash command is confirmed with Tab", () => {
		const onSelect = vi.fn();
		const overlay = createOverlay(onSelect);

		overlay.handleInput("\t");

		expect(onSelect).toHaveBeenCalledWith(commands[0], "tab");
		expect(getSlashCommandQueueKind("tab")).toBe("by-end");
	});
});

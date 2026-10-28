import {
	Container,
	Editor,
	getKeybindings,
	setKeybindings,
	stripTerminalSequences,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { redactJsonValue, redactUrl } from "../src/core/bug-report.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { reportBug } from "../src/modes/interactive/bug-report.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

describe("bug report prompt", () => {
	it("preserves line breaks in pasted descriptions", async () => {
		const previousKeybindings = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		try {
			const ui = new TuiMainScreen(new VirtualTerminal());
			const editorContainer = new Container();
			const editor = new Editor(ui, getEditorTheme());
			const session = {
				model: undefined,
				settingsManager: { getExternalEditorCommand: () => "nano" },
			} as unknown as AgentSession;
			const showStatus = vi.fn();

			const report = reportBug({
				session,
				ui,
				editorContainer,
				editor,
				keybindings,
				showStatus,
				showError: vi.fn(),
			});

			const descriptionEditor = editorContainer.children[0];
			expect(descriptionEditor).toBeInstanceOf(ExtensionEditorComponent);
			if (!(descriptionEditor instanceof ExtensionEditorComponent)) throw new Error("Missing description editor");
			descriptionEditor.handleInput("\x1b[200~Request failed\r\n  ↳ pi exiting...\r\nstack trace\x1b[201~");
			descriptionEditor.handleInput("\r");
			expect(editorContainer.children[0]).toBe(editor);

			await vi.waitFor(() => expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent));
			const transcriptSelector = editorContainer.children[0];
			if (!(transcriptSelector instanceof ExtensionSelectorComponent))
				throw new Error("Missing transcript selector");
			expect(transcriptSelector.render(120).join("\n")).toContain("Include the session transcript?");
			transcriptSelector.handleInput("j");
			transcriptSelector.handleInput("\r");
			expect(editorContainer.children[0]).toBe(editor);

			await vi.waitFor(() => expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent));
			const summarySelector = editorContainer.children[0];
			if (!(summarySelector instanceof ExtensionSelectorComponent)) throw new Error("Missing summary selector");
			expect(summarySelector.render(120).join("\n")).toContain("Attach a summary written by");
			summarySelector.handleInput("j");
			summarySelector.handleInput("\r");
			expect(editorContainer.children[0]).toBe(editor);

			await vi.waitFor(() => expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent));
			const deliverySelector = editorContainer.children[0];
			if (!(deliverySelector instanceof ExtensionSelectorComponent)) throw new Error("Missing delivery selector");
			const deliveryLines = deliverySelector.render(120).map(stripTerminalSequences);
			expect(deliveryLines.some((line) => line.includes("Description: Request failed"))).toBe(true);
			expect(deliveryLines.some((line) => line.includes("↳ pi exiting..."))).toBe(true);
			expect(deliveryLines.some((line) => line.includes("stack trace"))).toBe(true);

			deliverySelector.handleInput("j");
			deliverySelector.handleInput("j");
			deliverySelector.handleInput("\r");
			await report;
			expect(showStatus).toHaveBeenCalledWith("Bug report cancelled");
		} finally {
			setKeybindings(previousKeybindings);
		}
	});
});

describe("bug report redaction", () => {
	it("removes URL credentials and secret query parameters", () => {
		expect(redactUrl("https://user:pass@proxy.example.com:8080/")).toBe("https://proxy.example.com:8080/");
		expect(redactUrl("git:https://pat@github.com/org/repo")).toBe("git:https://github.com/org/repo");
		expect(redactUrl("https://api.example/v1?api-key=abc&model=x")).toBe(
			"https://api.example/v1?api-key=%3Credacted%3E&model=x",
		);
	});

	it("redacts nested secret values without hiding token counts", () => {
		expect(
			redactJsonValue({
				apiKey: "sk-123",
				headers: { Authorization: "Bearer x", "X-Trace": "1" },
				compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
				baseUrl: "https://me:secret@example.com/",
			}),
		).toEqual({
			apiKey: "<redacted>",
			headers: { Authorization: "<redacted>", "X-Trace": "1" },
			compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
			baseUrl: "https://example.com/",
		});
	});
});

import { Container, ProcessTerminal, Text, TUI } from "@kennyfrc/mu-tui";
import { initTheme } from "../../src/theme/theme.js";
import { ChatLayoutComponent } from "../../src/tui/chat-layout.js";
import { InlineToolOverlayComponent } from "../../src/tui/inline-tool-overlay.js";

type ProjectionSurface = "inline" | "dialog";

function getSurface(): ProjectionSurface {
	return process.env.MU_XTUI_PROJECTION_SURFACE === "dialog" ? "dialog" : "inline";
}

async function main(): Promise<void> {
	initTheme("dark");

	const ui = new TUI(new ProcessTerminal());
	const chatContent = new Container();
	chatContent.addChild(new Text("Transcript line", 0, 0));

	const composerContent = new Container();
	composerContent.addChild(new Text("Composer", 0, 0));

	const footer = new Container();
	footer.addChild(new Text("Footer", 0, 0));

	const projectionOverlay = new InlineToolOverlayComponent("web_search", {
		query: "projection system",
	});
	projectionOverlay.updateResult({
		content: [{ type: "text", text: "Projection docs\nProjection repo" }],
		isError: false,
		details: {
			projection: {
				version: 1,
				kind: "tool_panel",
				intent: { preferredSurface: getSurface() },
				state: {
					title: "Search Results",
					summary: "2 matches",
					items: ["Projection docs", "Projection repo"],
				},
			},
		},
	});

	const layout = new ChatLayoutComponent({
		chatContent,
		composerContent,
		inputTarget: composerContent,
		footer,
		getComposerLabel: () => "Input",
		getComposerBorderColor: () => (text: string) => text,
		updateComposerViewport: () => {},
		inlineOverlayContent: getSurface() === "inline" ? projectionOverlay : undefined,
	});

	ui.addChild(layout);
	ui.setFocus(getSurface() === "dialog" ? projectionOverlay : layout);
	if (getSurface() === "dialog") {
		ui.setOverlay(projectionOverlay, { width: 50, minWidth: 50, maxWidth: 50, marginX: 6, marginBottom: 4 });
	}

	ui.start();

	const shutdown = (): void => {
		ui.stop();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	await new Promise<void>(() => {
		setInterval(() => {}, 1000);
	});
}

void main();

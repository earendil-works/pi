import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { CURSOR_PROVIDER_ID, createCursorAgentProvider } from "./provider.ts";

function isCursorModel(model: { provider?: string } | undefined): boolean {
	return model?.provider === CURSOR_PROVIDER_ID;
}

export default function cursorAgentExtension(pi: ExtensionAPI): void {
	const { provider } = createCursorAgentProvider();
	pi.registerProvider(provider);

	let toolsBeforeCursor: string[] | undefined;

	const disableToolsForCursor = (): void => {
		if (toolsBeforeCursor === undefined) {
			toolsBeforeCursor = pi.getActiveTools();
		}
		pi.setActiveTools([]);
	};

	const restoreToolsIfNeeded = (): void => {
		if (toolsBeforeCursor === undefined) return;
		pi.setActiveTools(toolsBeforeCursor);
		toolsBeforeCursor = undefined;
	};

	const syncToolsForModel = (ctx: ExtensionContext, model = ctx.model): void => {
		if (isCursorModel(model)) {
			disableToolsForCursor();
		} else {
			restoreToolsIfNeeded();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		syncToolsForModel(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		syncToolsForModel(ctx, event.model);
	});
}

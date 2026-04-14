import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { VERSION } from "@mariozechner/pi-coding-agent";

function buildBanner(theme: Theme): string[] {
	const accent = (text: string) => theme.bold(theme.fg("accent", text));
	const dim = (text: string) => theme.fg("dim", text);

	return [
		accent(" ____  _  _____          _      "),
		accent("|  _ \\(_)/ ____|___   __| | ___ "),
		accent("| |_) | | |   / _ \\ / _` |/ _ \\"),
		accent("|  __/| | |__| (_) | (_| |  __/"),
		accent("|_|   |_|\\_____\\___/ \\__,_|\\___|"),
		dim(` PiCode v${VERSION}`),
	];
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((_tui, theme) => ({
			render(): string[] {
				return ["", ...buildBanner(theme), ""];
			},
			invalidate(): void {},
		}));
	});
}

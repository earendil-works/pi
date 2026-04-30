/**
 * Working Message Persistence Test
 *
 * Sets a custom working message and indicator on session start so you can
 * verify they survive across loader recreations (e.g. between agent turns).
 *
 * Usage:
 *   pi --extension examples/extensions/working-message-test.ts
 *
 * Then send a few messages in interactive mode. The working message should
 * stay "Working... (custom)" with a brown dot indicator every time the
 * loader appears, not revert to the default gray "Working...".
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CUSTOM_MESSAGE = "\x1b[38;2;155;86;63mWorking... (custom)\x1b[39m";
const CUSTOM_INDICATOR = { frames: ["\x1b[38;2;155;86;63m●\x1b[39m"] };

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(CUSTOM_MESSAGE);
		ctx.ui.setWorkingIndicator(CUSTOM_INDICATOR);
	});
}

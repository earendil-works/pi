// Composer text expanders (p2-tui-port.md 10.8): the web composer asks them, in key order, for the text to send
// (the prompt plugin expands `/template` and `/skill:` on the session worker). Plain TypeScript, so tests import it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Host } from "./chord.ts";
import { keyedRegistry } from "./chord.ts";

/** The text to send to a session's conversation instead of `text`, or undefined to leave it alone. */
export type ComposerExpander = (
	host: Host,
	session: string,
	conversation: number,
	text: string,
) => Promise<string | undefined>;
export const ComposerExpanders = keyedRegistry<ComposerExpander>("p2.web-composer-expanders");

/** `text` as the first expander (in key order) that changes it gives it, else unchanged. */
export async function expandComposerText(
	host: Host,
	session: string,
	conversation: number,
	text: string,
): Promise<string> {
	const table = [...(await host.registry(ComposerExpanders, BACKGROUND_CONTEXT)).value].sort(([a], [b]) =>
		a.localeCompare(b),
	);
	for (const [, expand] of table) {
		const expanded = await expand(host, session, conversation, text);
		if (expanded !== undefined && expanded !== text) return expanded;
	}
	return text;
}

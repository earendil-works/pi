/// <reference lib="dom" />
// The page's language (decision "Messages and languages in the app kit" (3)): the active language followed from the
// browser's `navigator.languages`, the user's `LocaleChoice` and the catalogs, written as `lang` and `dir` on the root
// element (right to left through the app's logical CSS properties). Components re-render through `useMessages`; nothing
// reloads.

import type { Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { followActiveLanguage, type MessagesReport } from "../surfaces/index.ts";

/** Follows the language on `host` and writes it on the root element until the returned stop; `report` gets reports. */
export async function followLanguage<P extends Principal>(
	host: Host<P>,
	report: (report: MessagesReport) => void,
	context: Context,
): Promise<() => void> {
	const root = document.documentElement;
	const follower = await followActiveLanguage(
		host,
		navigator.languages,
		(language) => {
			root.lang = language.locale;
			root.dir = language.dir;
		},
		report,
		context,
	);
	const devicechanged = (): void => follower.setDevice(navigator.languages);
	addEventListener("languagechange", devicechanged);
	return () => {
		follower.stop();
		removeEventListener("languagechange", devicechanged);
	};
}

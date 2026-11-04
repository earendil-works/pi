// The active language of a client (decision "Messages and languages in the app kit" (3)): the `Translations` registry
// on the client's host (served there by the kit), the user's `LocaleChoice` (held on the server; until it binds, or
// when the app serves none, no pick) and the device's languages, combined. The host keeps it as page state
// (`hostLanguage`), where `useMessages` and `TuiScope.messages` read and follow it; each change also calls the client's
// writer (`lang` and `dir` on a page). Reports are passed on once each.

import { type Context, withAbortSignal } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { createLanguage, type Language, type MessagesReport, resolveLocale } from "./language.ts";
import { LocaleChoice } from "./locale-choice.ts";
import { type PageState, pageState } from "./page-state.ts";
import { NO_TRANSLATIONS, type TranslationIndex, Translations } from "./translations.ts";

/** A client's active language as it follows it: the device's languages can change (a browser's), and it ends. */
export type LanguageFollower = {
	/** The device's languages changed: the locale is resolved again. */
	setDevice(preferred: readonly string[]): void;
	stop(): void;
};

/**
 * Follows the active language on `host` for the device's `preferred` languages: sets the host's language (and calls
 * `changed` with it) at once and at every change of the registry, the user's pick or the device's languages that
 * changes the locale or the catalogs, until `stop`. `report` gets each distinct report once.
 */
export async function followActiveLanguage<P extends Principal>(
	host: Host<P>,
	preferred: readonly string[],
	changed: (language: Language) => void,
	report: (report: MessagesReport) => void,
	context: Context,
): Promise<LanguageFollower> {
	const abort = new AbortController();
	const ctx = withAbortSignal(abort.signal, context);
	const state = hostLanguage(host);
	const once = reportOnce(report);
	let translations: TranslationIndex = NO_TRANSLATIONS;
	let pick: string | null = null;
	let device = preferred;
	const update = (): void => {
		const locale = resolveLocale(pick, device, translations.locales);
		const current = state.read();
		if (current?.locale === locale && current.translations === translations) return;
		const language = createLanguage(locale, translations, once);
		state.set(language);
		changed(language);
	};
	update();
	const registry = await host.registry(Translations, ctx);
	translations = registry.value;
	update();
	(await registry.watch(ctx)).start(async (call) => {
		if (call.kind === "value") translations = call.value;
		update();
	});
	const choice = host.hold(LocaleChoice, {}, ctx);
	choice.pick.watch(ctx).then(
		(watch) =>
			watch.start(async (call) => {
				if (call.kind === "value") pick = call.value;
				update();
			}),
		// The hold ended (the follower stopped) before its first value.
		() => {},
	);
	return {
		setDevice: (next) => {
			device = next;
			update();
		},
		stop: () => {
			abort.abort();
			choice.release();
		},
	};
}

/** The page state key of a host's language. */
const LANGUAGE = "chord.language";

/** `host`'s active language, kept as its page state: `undefined` until a follower sets it (then `t` renders the first catalog). */
export function hostLanguage<P extends Principal>(host: Host<P>): PageState<Language | undefined> {
	return pageState<Language | undefined, P>(host, LANGUAGE, undefined);
}

/** `report`, called once per distinct report (by kind, namespace, locale and key). */
function reportOnce(report: (report: MessagesReport) => void): (report: MessagesReport) => void {
	const seen = new Set<string>();
	return (each) => {
		const id = `${each.kind}|${each.namespace}|${"locale" in each ? each.locale : ""}|${each.key}`;
		if (seen.has(id)) return;
		seen.add(id);
		report(each);
	};
}

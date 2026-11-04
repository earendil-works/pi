// Languages as contributions (decision "Messages and languages in the app kit" (2), refined in the build): the
// `Translations` registry, served on the server, pages and terminals by the kit. A contribution is a list of catalogs,
// `{ namespace, locale, messages, override? }`: a plugin contributes its own catalogs (`t.translations`) from each
// facet that renders, a translation plugin its catalogs for other plugins. The composed index has one catalog per
// namespace and locale: the first by plugin name wins and the other is reported, except that `override: true` wins over
// a catalog without it. Registries are per host, so catalogs (they hold functions) never cross links.

import type { Principal } from "../data/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import {
	type ComposeContext,
	defineRegistry,
	type Registry,
	type RegistryTable,
	type TableItem,
} from "../registries/index.ts";
import type { Catalog } from "./messages.ts";

/** One catalog: the messages of `namespace` in `locale`; `override: true` replaces the plugin's own for that locale. */
export type Translation = {
	readonly namespace: string;
	readonly locale: string;
	/** Partial allowed: a missing key falls back (the locale's base, then the namespace's first catalog). */
	readonly messages: Catalog;
	readonly override?: true;
};

/** The composed catalogs: the one used per namespace and canonical locale, with its plugin; every locale offered. */
export type TranslationIndex = {
	readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, TableItem<Translation>>>;
	/** Every locale some catalog offers, canonical (`pt-BR`), sorted. */
	readonly locales: readonly string[];
};

/** The catalogs plugins contribute, a list per contributor; served on the server, pages and terminals by the kit. */
export const Translations: Registry<readonly Translation[], TranslationIndex> = defineRegistry<
	readonly Translation[],
	TranslationIndex
>("chord.translations", { version: 1 });

/** No catalogs: what a host's language has before its `Translations` value arrives. */
export const NO_TRANSLATIONS: TranslationIndex = { catalogs: new Map(), locales: [] };

/** The kit's facet serving `Translations` on a host. */
export function translationsFacet<P extends Principal>(): Facet<P> {
	return defineFacet<P>((host) => host.serve(Translations, { compose: composeTranslations }));
}

/** The index of `table`: per namespace and locale the winning catalog; conflicts and invalid locales reported. */
export function composeTranslations(
	table: RegistryTable<readonly Translation[]>,
	{ report }: ComposeContext,
): TranslationIndex {
	const catalogs = new Map<string, Map<string, TableItem<Translation>>>();
	const locales = new Set<string>();
	for (const { value, plugin } of table) {
		for (const translation of value) {
			const locale = canonicalLocale(translation.locale);
			if (locale === undefined) {
				report({ message: `"${translation.locale}" is no locale (${translation.namespace})`, plugins: [plugin] });
				continue;
			}
			locales.add(locale);
			let byLocale = catalogs.get(translation.namespace);
			if (byLocale === undefined) {
				byLocale = new Map();
				catalogs.set(translation.namespace, byLocale);
			}
			const taken = byLocale.get(locale);
			if (taken === undefined || (translation.override === true && taken.value.override !== true)) {
				byLocale.set(locale, { value: translation, plugin });
			} else if ((translation.override === true) === (taken.value.override === true)) {
				report({
					message: `${translation.namespace} in ${locale} is contributed twice`,
					plugins: [taken.plugin, plugin],
				});
			}
		}
	}
	return { catalogs, locales: [...locales].sort() };
}

/** `locale` canonical (`pt-br` is `pt-BR`), or `undefined` when it is no language tag. */
export function canonicalLocale(locale: string): string | undefined {
	try {
		return Intl.getCanonicalLocales(locale)[0];
	} catch {
		return undefined;
	}
}

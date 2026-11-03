// Messages in code (decision "Messages and languages in the app kit" (1), (4), refined in the build): a plugin defines
// its texts once, per namespace, in a shared `messages.ts` every facet that renders imports: `defineMessages("notes", {
// en: {...}, de: {...} })` returns a typed `t`. The first catalog defines the keys and their argument types; every
// other catalog must have the same keys with the same signatures (a missing key, an unknown one or a wrong argument is
// a type error); values are strings or functions (plurals, word order). `t` renders in a language: bound to a host's
// (`useMessages`, `scope.messages`, `t.in`), or plain, in the render under way's, else in the first catalog.
// `t.message` builds a message as data (`{ namespace, key, params }`) for state, notices and errors, which each client
// renders with `t.render` in its own language, checked at runtime (it crossed a link).

import { arr, bool, nul, num, obj, str, union } from "../contracts/index.ts";
import { checkName } from "../contracts/names.ts";
import { currentLanguage, inLanguage, type Language } from "./language.ts";
import { canonicalLocale, type Translation } from "./translations.ts";

/** A message's value: a text, or a function of its arguments returning one. */
export type MessageValue = string | ((...args: never[]) => string);

/** A catalog: the messages of one namespace in one language, by key. */
export type Catalog = { readonly [key: string]: MessageValue };

/** A catalog's shape as other catalogs must match it: its keys, strings as `string`, functions with their signatures. */
export type CatalogShape<M> = { readonly [K in keyof M]: M[K] extends string ? string : M[K] };

/** The arguments of a message: its function's parameters, none for a text. */
export type MessageArgs<V> = V extends (...args: infer A) => string ? A : [];

/** A parameter of a message as data: plain JSON (a date as an ISO string or a number), so it crosses links. */
export type MessageParam = string | number | boolean | null;

/**
 * A message as data: its namespace, its key and its parameters; typed by `t.message` (`MessageData<"notes", "saved">`),
 * any namespace and key as `MessageSchema` carries it across a link. (`Message` is the link protocol's.)
 */
export type MessageData<N extends string = string, K extends string = string> = {
	readonly namespace: N;
	readonly key: K;
	// Not a readonly array: a message goes into documents, whose drafts are mutable (immutable by convention).
	readonly params: MessageParam[];
};

/** The schema of a message as data, for contract members (`notice: union([MessageSchema, nul()])`). */
export const MessageSchema = obj({
	namespace: str(),
	key: str(),
	params: arr(union([str(), num(), bool(), nul()])),
});

/** The keys of `M` whose arguments are all `MessageParam`s: those `t.message` can build. */
export type DataKeys<M> = {
	[K in keyof M & string]: MessageArgs<M[K]> extends readonly MessageParam[] ? K : never;
}[keyof M & string];

/** A message of namespace `N`, or one of any namespace (`string`, from a schema): another literal namespace is refused. */
type OfNamespace<G extends MessageData, N extends string> = string extends G["namespace"]
	? unknown
	: { readonly namespace: N };

/** Renders the messages of namespace `N` with catalog shape `M` in one language. */
export type Translator<N extends string, M> = {
	/** The message `key` with its arguments. */
	<K extends keyof M & string>(key: K, ...args: MessageArgs<M[K]>): string;
	/** A message as data; a foreign namespace or an unknown key shows the key (and is reported). */
	render<G extends MessageData>(message: G & OfNamespace<G, N>): string;
};

/** A plugin's messages: `t` itself (in the current language), its namespace, its catalogs as contributions, `message`. */
export type Messages<N extends string, M> = Translator<N, M> & {
	readonly namespace: N;
	/** Its catalogs as `Translations` entries: a facet that renders contributes them. */
	readonly translations: readonly Translation[];
	/** The message `key` with its arguments as data, for state that clients render. */
	message<K extends DataKeys<M>>(key: K, ...args: MessageArgs<M[K]>): MessageData<N, K>;
	/** `t` in `language` (`undefined`: the first catalog). */
	in(language: Language | undefined): Translator<N, M>;
};

/** The catalog shape of a plugin's messages: what a translation fills (`const fr: MessagesOf<typeof t> = {...}`). */
export type MessagesOf<T> = T extends Messages<string, infer M> ? M : never;

/**
 * The messages of `namespace` (a name like a type's, `[a-z0-9@/._~-]`) in `catalogs` by locale; the first catalog
 * defines the keys and signatures, the others match it.
 */
export function defineMessages<const N extends string, M extends Catalog>(
	namespace: N,
	catalogs: { readonly [locale: string]: CatalogShape<M> },
): Messages<N, CatalogShape<M>> {
	// Declaration policy: a namespace is a name, a catalog's key a language tag (JavaScript callers reach both).
	checkName(namespace, "A messages namespace");
	const own = new Map<string, Catalog>();
	for (const [locale, catalog] of Object.entries(catalogs)) {
		const canonical = canonicalLocale(locale);
		if (canonical === undefined) throw new Error(`${namespace}: "${locale}" is no language tag`);
		own.set(canonical, catalog);
	}
	const first = own.values().next().value;
	if (first === undefined) throw new Error(`${namespace}: defineMessages needs a catalog`);
	const source: Source = { namespace, own, first };
	const translations = [...own].map(([locale, messages]) => ({ namespace, locale, messages }));
	// The overloads `Messages` types are these functions', keyed by the catalog's shape.
	return Object.assign(translator<N, CatalogShape<M>>(source, currentLanguage), {
		namespace,
		translations,
		message: (key: string, ...params: MessageParam[]) => ({ namespace, key, params }),
		in: (language: Language | undefined) => translator<N, CatalogShape<M>>(source, () => language),
	}) as Messages<N, CatalogShape<M>>;
}

/** A namespace's own catalogs, by canonical locale, and its first. */
type Source = { readonly namespace: string; readonly own: ReadonlyMap<string, Catalog>; readonly first: Catalog };

/** A translator of `source`'s messages in the language `language` reads at each call. */
function translator<N extends string, M>(source: Source, language: () => Language | undefined): Translator<N, M> {
	const t = (key: string, ...args: unknown[]): string => renderKey(source, language(), key, args);
	const render = (message: MessageData): string => renderData(source, language(), message);
	// The overloads `Translator` types are this one function's, keyed by the catalog's shape.
	return Object.assign(t, { render }) as unknown as Translator<N, M>;
}

/**
 * `key` of `source` in `language`: down its chain, at each locale the host's contributed catalog, then the plugin's own;
 * else the first catalog.
 */
function renderKey(source: Source, language: Language | undefined, key: string, args: readonly unknown[]): string {
	if (language === undefined) return call(source.first[key]!, args);
	return inLanguage(language, () => {
		for (const [index, locale] of language.chain.entries()) {
			const contributed = language.translations.catalogs.get(source.namespace)?.get(locale);
			if (contributed !== undefined && Object.hasOwn(contributed.value.messages, key)) {
				try {
					return found(language, source, key, index, call(contributed.value.messages[key]!, args));
				} catch (error) {
					// A contributed catalog is a plugin's code: reported, and the chain goes on (design §17).
					const { plugin } = contributed;
					language.report({ kind: "failed", namespace: source.namespace, locale, key, plugin, error });
				}
			}
			const own = source.own.get(locale);
			if (own !== undefined && own !== contributed?.value.messages && Object.hasOwn(own, key)) {
				return found(language, source, key, index, call(own[key]!, args));
			}
		}
		return found(language, source, key, language.chain.length, call(source.first[key]!, args));
	});
}

/** `text`, found at `index` in `language`'s chain (its length: the first catalog), a fallback reported past the first. */
function found(language: Language, source: Source, key: string, index: number, text: string): string {
	if (index > 0) {
		const used = language.chain[index];
		language.report({ kind: "fallback", namespace: source.namespace, locale: language.locale, key, used });
	}
	return text;
}

/** A message's text: the text, or the function called with `args` (typed by the catalog's signature). */
function call(value: MessageValue, args: readonly unknown[]): string {
	return typeof value === "string" ? value : (value as (...params: readonly unknown[]) => string)(...args);
}

/**
 * A message as data in `language`. Checked first (wire input: the message crossed a link as state): another namespace,
 * a key the first catalog lacks or params that are no list show the key, reported; so does a message that throws.
 */
function renderData(source: Source, language: Language | undefined, message: MessageData): string {
	const { namespace, key, params } = message;
	const known = namespace === source.namespace && Object.hasOwn(source.first, key) && Array.isArray(params);
	if (!known) {
		language?.report({ kind: "unknown", namespace, key, expected: source.namespace });
		return key;
	}
	try {
		return renderKey(source, language, key, params);
	} catch (error) {
		language?.report({ kind: "failed", namespace, locale: language.locale, key, plugin: undefined, error });
		return key;
	}
}

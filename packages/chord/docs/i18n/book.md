---
title: Speaking Every Language: i18n in the app kit
cover: i18n / in the App Kit
kicker: A proposal · Chord v2 app kit · 2026-11-02
subtitle: How an app and its plugins write their texts once, in code, and show them in each viewer's language
stats:
  - 1 | function a plugin calls: t(key, ...args)
  - 0 | message files outside the code
  - 0 | page reloads to switch a language
note: |
  A proposal by the redesign session, asked for by the owner on 2026-11-02 ("i18n also needs to be part of the app
  kit"; "need code example"). It starts from mini-lit's `src/i18n.ts` (typed catalogs in code) and adapts it to
  plugins that are built separately, reload live and run on several hosts. Accepted 2026-11-03 and built after slice
  11, with three refinements (a contribution is a list, each rendering facet contributes its plugin's own catalogs,
  `t` is bound per host): design.md §23 "Messages and languages" is the current statement.
colophon: Speaking Every Language · proposal · 2026-11-02
---

# Before we begin {.preface}

Lena uses p3 in German; her colleague Tom, a guest in her session, reads English. The notes plugin shows "New note"
to Tom and "Neue Notiz" to Lena, on the same page served by the same server. A French translator later adds French to
the app and to every plugin, without touching any of them. And when Lena switches to French, nothing reloads: the
text on her screen changes, the half-written message stays.

mini-lit already does the first part well: messages are TypeScript objects, keyed and type-checked, so a missing
German text is a compile error. Three things do not carry over: its messages are one global table extended by
declaration merging (which separately built plugins cannot share), the language lives in `localStorage` and switching
reloads the page, and every text is formatted where it is shown, which breaks when the server formats a message for
two viewers with two languages.

## Five things to know

:::findings
1. **Messages stay in code,** per plugin: `defineMessages("notes", { en: {...}, de: {...} })` returns a typed `t`.
2. **Values may be functions,** for plurals and parameters; dates and numbers go through `Intl`.
3. **Languages are contributions:** a `Translations` registry adds a language to any plugin, the app included.
4. **The language is a user preference,** from the browser or the system locale by default; switching re-renders live.
5. **Servers and workers never format text for people:** they send a key and its parameters, and each viewer's client
   renders them in its own language.
:::

## Words used throughout

A **message** is one text with a key (`newNote`). A **catalog** is the messages of one plugin in one language. A
**namespace** is the plugin a catalog belongs to. A **locale** is a language tag (`de`, `pt-BR`).

# Messages in Code {#messages lede="Each plugin defines its own messages and gets a typed function back."}

```ts
// plugins/notes/messages.ts
import { defineMessages } from "@p3/app/v1";

export const t = defineMessages("notes", {
	en: {
		newNote: "New note",
		empty: "No notes yet",
		count: (n: number) => (n === 1 ? "1 note" : `${n} notes`),
		saved: (title: string, at: Date) => `Saved "${title}" at ${formatTime(at)}`,
	},
	de: {
		newNote: "Neue Notiz",
		empty: "Noch keine Notizen",
		count: (n) => (n === 1 ? "1 Notiz" : `${n} Notizen`),
		saved: (title, at) => `„${title}“ um ${formatTime(at)} gespeichert`,
	},
});
```

```tsx
// plugins/notes/web.tsx
import { t } from "./messages.ts";

function NotesHeader({ count }: { count: number }) {
	return <h2>{t("count", count)} <button>{t("newNote")}</button></h2>;
}
```

The first catalog (`en`) defines the keys and their argument types; every other catalog must have the same keys with
the same signatures, so a missing German text, a typo in a key or a wrong argument is a type error, not a blank in
production. `t("count", "3")` does not compile. The namespace (`"notes"`) keeps two plugins' `empty` apart.

Functions cover what plain strings cannot: plurals (`count`), parameters in the right word order (`saved` puts the
title first in English and German alike, but another language may not), and gender or case where a language needs it.
Plural rules beyond one and many use `Intl.PluralRules`; dates, times and numbers use `Intl.DateTimeFormat` and
`Intl.NumberFormat` with the viewer's locale, through two small helpers (`formatTime`, `formatNumber`) that read the
current locale like `t`.

# Languages as Contributions {#translations lede="Adding French to the app and every plugin without editing them."}

A plugin ships the languages its author speaks. Everything else can come from anyone, as a contribution:

```ts
// plugins/french/web.ts (a translation plugin)
import { defineFacet, Translations } from "@p3/app/v1";
import type { MessagesOf } from "@p3/app/v1";
import type { t as notes } from "../notes/messages.ts";   // the notes plugin's keys, for the type check

const notesFr: MessagesOf<typeof notes> = {
	newNote: "Nouvelle note",
	empty: "Aucune note",
	count: (n) => (n <= 1 ? `${n} note` : `${n} notes`),
	saved: (title, at) => `« ${title} » enregistrée à ${formatTime(at)}`,
};

export default defineFacet((_host, self) => {
	self.contribute(Translations, { namespace: "notes", locale: "fr", messages: notesFr });
	self.contribute(Translations, { namespace: "app", locale: "fr", messages: appFr });
});
```

- `MessagesOf<typeof t>` gives a translation plugin the exact keys and signatures to fill, from the plugin it
  translates (an imported type, erased at build).
- A catalog may be partial: a missing key falls back to the plugin's own catalog for that language's base (`pt-BR` to
  `pt`), then to the first catalog (`en`), key by key. A fallback is reported once in the logs, so gaps are visible.
- Two contributions for the same namespace and locale: the first by plugin name wins, the other is reported (the
  registry rule for conflicts).
- A plugin's own catalogs are its built-in contributions; a translation plugin can also override one of them (a
  better German), contributed explicitly with `override: true`.

## One file, every host

Registries are per host: a contribution lives on the host whose facet made it. A French catalog contributed from the
web facet exists in browser pages only. So a plugin keeps its messages in one shared file, `messages.ts`, which every
facet that renders text imports (the web and TUI facets; the worker's too when it builds messages with `t.message`),
and a translation plugin keeps its catalog in one shared file too and contributes it from each facet that renders:

```ts
// plugins/french/fr.ts: the catalogs, written once
export const notesFr: MessagesOf<typeof notes> = { newNote: "Nouvelle note", /* ... */ };
// plugins/french/web.ts and plugins/french/tui.ts: the same two lines each
export default defineFacet((_host, self) => self.contribute(Translations, { namespace: "notes", locale: "fr", messages: notesFr }));
```

The server and workers need catalogs only when they produce final text themselves (an email, a push notification);
then their facets contribute them too, and the text is rendered in the recipient's language from their preference.
Catalogs never travel over links: they contain functions.

# Choosing a Language {#locale lede="Per viewer, defaulted from the device, switched live."}

The language is a user preference, kept with the user's other preferences (the kit's per-principal document, like
the theme choice), so it follows a person across devices:

- **Default:** the browser's `navigator.languages` on the web, the system locale in the TUI, matched against the
  locales any catalog offers.
- **Switching:** the app's settings show the locales available (the union of all catalogs); choosing one writes the
  preference. `t` reads the current locale from a watchable; React components re-render through a hook, the TUI
  redraws through its scope. Nothing reloads.

```tsx
// any web component
const { t, locale } = useMessages(notesMessages);   // re-renders when the locale or a translation changes
```

When a translation plugin is edited and rolled out, the registry recomposes and the open pages show the new text, as
with themes.

# Text from the Server {#server lede="Why the server sends keys, not sentences."}

The server and the workers also produce text people read: a notice ("Worker failed to start"), a tool card's
summary, a status line, an error. If the worker formatted "Notiz gespeichert" for Lena, Tom would read German too:
both look at the same object state.

So objects carry messages as data, and each client renders them:

```ts
// plugins/notes/contract.ts: a member of the Notes object's state holds a message as data
lastSaved: opt(obj({ namespace: str(), key: str(), params: arr(unknown()) })),

// plugins/notes/worker.ts: the object writes the key and its parameters, never a sentence; the same `t` builds it
import { t } from "./messages.ts";
await self.tx(async (tx) => {
	(await tx.draft(status)).lastSaved = t.message("saved", note.title, note.at);   // typed: key and arguments checked
}, ctx);

// plugins/notes/web.tsx: each viewer renders it in its own language
const notes = useHold(Notes, { session });
const text = notes.lastSaved && t.render(notes.lastSaved);   // typed against the notes catalog
```

`t.message` returns a `Message<"notes">`, plain data `{ namespace, key, params }`, typed against the first catalog:
`t.message("saved", 42)` and `t.message("svaed", ...)` are type errors. `t.render` takes only `Message<"notes">`. Across a
link the contract's member is a generic message schema, so `t.render` checks the namespace and key at runtime and
shows the key for an unknown one. The writer and the reader are type-checked; the hop between them is checked at
runtime.

The same holds for anything else that reaches people: an app's notices object stores `{ namespace, key, params }`
per notice, a tool card's summary carries one, an error shown to a user carries a code and parameters.

Parameters are plain data (strings, numbers, ISO dates), so they cross links like any state. What is never
translated: the model's prompts and the model's own answers (the conversation's language is the user's business with
the model), log lines (for developers, in English), error codes. Error *messages* shown to people follow the same rule
as notices: a code plus parameters, rendered by the client.

# Open Questions {.epilogue lede="To decide."}

1. **Keys or English text as keys.** mini-lit keys by the English text (`"Copy"`), which reads well and needs no key
   names; named keys (`newNote`) survive rewording the English. Recommendation: named keys, with the English catalog
   as the source of truth.
2. **A file format for translators.** Code catalogs are best for developers and agents; human translators may want
   JSON or PO files. Recommendation: no files now; a small tool can export a plugin's catalogs to JSON and import them
   back into a translation plugin when someone needs it.
3. **Right-to-left languages.** The page sets `dir` from the locale; the app's CSS uses logical properties
   (`margin-inline-start`). Recommendation: the kit sets `lang` and `dir` on the root; components are the app's.
4. **The TUI's locale.** From the system locale, overridden by the user's preference, like the web.

# API in Brief {.appendix}

| Piece | Where | What |
| --- | --- | --- |
| `defineMessages(namespace, catalogs)` | the app's API (shared) | typed `t(key, ...args)`, `t.render(message)` |
| `MessagesOf<typeof t>` | the app's API (type) | the keys and signatures a translation must fill |
| `Translations` | the app's API (shared registry) | `{ namespace, locale, messages, override? }` |
| `useMessages(t)` | the app's web module | the hook re-rendering on locale or translation changes |
| `formatTime`, `formatNumber` | the app's API | `Intl` helpers in the viewer's locale |
| the locale preference | the kit's per-principal preferences | default from the device, switched live |
| `{ namespace, key, params }` | object state and notices | a message as data, rendered by each client |

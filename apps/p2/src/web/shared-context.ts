// React contexts several plugins' web facets share. Each plugin's web script is built on its own, a file one imports from
// another copied into it: a context made in such a file would be a second object there, and React matches a provider
// and its consumers by the object. The page's core (one instance for every script) keeps one context per name.
import { type Context, createContext } from "react";

const contexts = new Map<string, Context<unknown>>();

/** The page's one context named `name` (`initial` its default, from whichever script asked first). */
export function sharedContext<T>(name: string, initial: T): Context<T> {
	let context = contexts.get(name);
	if (context === undefined) {
		context = createContext<unknown>(initial);
		contexts.set(name, context);
	}
	// The name is the plugin's: every script asking for it is built from the same file, so with the same type.
	return context as Context<T>;
}

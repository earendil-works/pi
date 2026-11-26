// What a refused call says to a person, for the panes of the kinds that reach machines (Files, Terminals): the message
// a refusal's details carry (`{ message }`, as the plugins refuse) rendered by the translator of its namespace, else
// the error's own text.

import { isChordError, type MessageData, type Translator } from "@earendil-works/p3/v1";

/** The text of `failure` for a person, through `translators` by namespace (the pane's and the plugins' it calls). */
export function refusalText(
	failure: unknown,
	translators: Readonly<Record<string, Translator<string, never>>>,
): string {
	const message = isChordError(failure) ? messageIn(failure.details) : undefined;
	const translator = message === undefined ? undefined : translators[message.namespace];
	if (message !== undefined && translator !== undefined) return translator.render(message);
	return failure instanceof Error ? failure.message : String(failure);
}

/** The message a refusal's details carry, if any. A trust boundary: the details came over the wire. */
function messageIn(details: unknown): MessageData | undefined {
	if (details === null || typeof details !== "object" || !("message" in details)) return undefined;
	const { message } = details;
	if (message === null || typeof message !== "object") return undefined;
	if (!("namespace" in message && "key" in message && "params" in message)) return undefined;
	const { namespace, key, params } = message;
	if (typeof namespace !== "string" || typeof key !== "string" || !Array.isArray(params)) return undefined;
	return { namespace, key, params };
}

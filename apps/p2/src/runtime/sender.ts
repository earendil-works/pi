// The first block of every model message a person, a peer session or a subagent sends (browser-safe): `<sender
// kind="owner" name="Mario"/>`. The system prompt tells the model to attribute input by it; nothing reads it back, readers use the
// entry data.
import type { Author } from "./principals.ts";

export type { Author } from "./principals.ts";

/** Who sent an input, as the model reads it. */
export type Sender =
	| { readonly kind: "owner"; readonly name: string }
	| { readonly kind: "guest"; readonly id: string; readonly name: string }
	| { readonly kind: "session"; readonly id: string; readonly title: string }
	| { readonly kind: "subagent"; readonly name: string };

/** How a sender block starts; the fake provider strips it from the text it echoes. */
export const SENDER_PREFIX = "<sender ";

/** The sender block of `sender`, its values escaped: names and titles are chosen by people. */
export function senderText(sender: Sender): string {
	const attributes = Object.entries(sender)
		.map(([key, value]) => `${key}="${escapeAttribute(String(value))}"`)
		.join(" ");
	return `<sender ${attributes}/>`;
}

/** The sender block of a person's input. */
export function authorSender(author: Author): Sender {
	return author.kind === "owner"
		? { kind: "owner", name: author.name }
		: { kind: "guest", id: author.id, name: author.name };
}

const escapeAttribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

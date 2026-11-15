// File references in a message's text: Markdown links with the `attachment:` scheme, `![name](attachment:<id>)` for an
// image shown inline and `[name](attachment:<id>)` for any file. The text decides where each file sits; a reference
// counts only when its ID is one of the message's attachments (the composer's file keys before upload, the session's
// upload IDs after), so pasted Markdown and look-alikes stay text and nothing needs escaping beyond the link text.

/** One reference in a text: where it is (UTF-16 offsets), its link text, its target ID and whether it embeds. */
export type FileReference = {
	readonly start: number;
	readonly end: number;
	readonly image: boolean;
	readonly label: string;
	readonly id: string;
};

/** The parts of a text: plain runs and references, in order. */
export type ReferencePart =
	| { readonly kind: "text"; readonly text: string }
	| ({ readonly kind: "ref" } & FileReference);

const REFERENCE = /(!?)\[((?:\\.|[^\\\]\n])*)\]\(attachment:([A-Za-z0-9_-]+)\)/g;

/** Every `attachment:` reference in `text`, in order. */
export function fileReferences(text: string): FileReference[] {
	const found: FileReference[] = [];
	for (const match of text.matchAll(REFERENCE)) {
		const start = match.index;
		found.push({
			start,
			end: start + match[0].length,
			image: match[1] === "!",
			label: match[2]!.replace(/\\(.)/g, "$1"),
			id: match[3]!,
		});
	}
	return found;
}

/** `text` split into plain runs and the references `known` accepts (all of them without it). */
export function referenceParts(text: string, known?: (id: string) => boolean): ReferencePart[] {
	const parts: ReferencePart[] = [];
	let at = 0;
	for (const reference of fileReferences(text)) {
		if (known && !known(reference.id)) continue;
		if (reference.start > at) parts.push({ kind: "text", text: text.slice(at, reference.start) });
		parts.push({ kind: "ref", ...reference });
		at = reference.end;
	}
	if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
	return parts;
}

/** The reference to file `id` named `label`: embedded (`![…]`) for an image, linked (`[…]`) for other files. */
export function referenceText(label: string, id: string, image: boolean): string {
	return `${image ? "!" : ""}[${escapeLabel(label)}](attachment:${id})`;
}

/** `text` with each reference shown as its bracketed name, for previews, titles and the terminal. */
export function plainReferences(text: string): string {
	return referenceParts(text)
		.map((part) => (part.kind === "text" ? part.text : `[${part.label}]`))
		.join("");
}

/** `text` with the references to `ids` renamed by `rename` (the composer's file keys to upload IDs at send). */
export function renameReferences(text: string, rename: (id: string) => string | undefined): string {
	return referenceParts(text)
		.map((part) => {
			if (part.kind === "text") return part.text;
			const id = rename(part.id);
			return id === undefined ? `[${escapeLabel(part.label)}]` : referenceText(part.label, id, part.image);
		})
		.join("");
}

function escapeLabel(label: string): string {
	return label.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/\n/g, " ");
}

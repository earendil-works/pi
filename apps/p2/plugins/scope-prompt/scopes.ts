// What the person points at, read from the page's DOM: the chain of things around a point (the sidebar, a rollup, a
// group, a session; a pane, a file of the changes, a diff line; a message of the transcript), outermost first, each
// from attributes its plugin already renders. Nothing here changes the page.

/** One thing the person may point at: its kind, a short label, the facts that name it, and its element. */
export type ScopeLevel = {
	readonly kind: string;
	readonly label: string;
	readonly data: Readonly<Record<string, string | number>>;
	readonly element: Element;
};

/** The things around `element`, outermost first; empty when it lies in nothing a prompt can point at. */
export function scopesAt(element: Element | null): ScopeLevel[] {
	const levels: ScopeLevel[] = [];
	for (let at = element; at && at !== document.body; at = at.parentElement) {
		const level = levelOf(at);
		if (level) levels.unshift(level);
	}
	return levels;
}

/** The level `element` is, if any. */
function levelOf(element: Element): ScopeLevel | undefined {
	if (element.classList.contains("diff-line")) return diffLine(element);
	const path = element.getAttribute("data-path");
	if (path) return { kind: "file", label: path, data: { path }, element };
	const entry = element.getAttribute("data-entry");
	if (entry) return message(element, Number(entry));
	const view = element.getAttribute("data-view-pane");
	if (view) return pane(element, view);
	const session = element.getAttribute("data-session");
	if (session) {
		const title = textOf(element.querySelector(".session-header .session-title"));
		return { kind: "session", label: title || "Session", data: { session, title }, element };
	}
	const key = element.getAttribute("data-key");
	if (key && element.classList.contains("sidebar-group")) {
		const name = textOf(element.querySelector(".group-row .session-title"));
		return { kind: "group", label: name || "Group", data: { key, name }, element };
	}
	if (key && element.classList.contains("sidebar-section")) {
		const name = textOf(element.querySelector(".rollup-row .nav-label"));
		return { kind: "rollup", label: name || "Rollup", data: { key, name }, element };
	}
	if (element.classList.contains("drawer")) return { kind: "sidebar", label: "Sidebar", data: {}, element };
	return undefined;
}

/** A line of a diff (`LinesBlock`): its number in the new file (old for a removed line), how it changed, its text. */
function diffLine(element: Element): ScopeLevel {
	const number = Number(textOf(element.querySelector(".diff-number")));
	const text = textOf(element.querySelector(".diff-code"), 300);
	if (element.classList.contains("hunk") || element.classList.contains("meta") || !number)
		return { kind: "hunk", label: excerpt(text, 40), data: { text }, element };
	const change = element.classList.contains("add")
		? "added"
		: element.classList.contains("del")
			? "removed"
			: "unchanged";
	return { kind: "line", label: `Line ${number}`, data: { line: number, change, text }, element };
}

/** A transcript entry (`data-entry`): who wrote it and the start of its text. */
function message(element: Element, entry: number): ScopeLevel {
	const role = element.classList.contains("user")
		? "person"
		: element.classList.contains("incoming")
			? "incoming"
			: element.classList.contains("thinking")
				? "thought"
				: "assistant";
	const text = messageText(element);
	return { kind: "message", label: ROLE_WORDS[role] ?? "Message", data: { entry, role, text }, element };
}

const ROLE_WORDS: Record<string, string> = {
	person: "Message",
	incoming: "Incoming message",
	thought: "Thought",
	assistant: "Answer",
};

/** What a message says, without its speaker, time, actions and notes. */
function messageText(element: Element): string {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let text = "";
	for (let node = walker.nextNode(); node && text.length < 600; node = walker.nextNode())
		if (!node.parentElement?.closest(MESSAGE_CHROME)) text += node.textContent ?? "";
	return text.replace(/\s+/g, " ").trim().slice(0, 600);
}

/** The parts of a transcript entry around what it says (Chat.tsx). */
const MESSAGE_CHROME = "button, .speaker, .reply-quote, .message-actions, .bubble-files, .bubble-note, .incoming-head";

/** A pane of the workbench: the chat, or a view with its kind, item and title (Workbench.tsx's attributes). */
function pane(element: Element, view: string): ScopeLevel {
	if (view === "transcript") return { kind: "transcript", label: "Chat", data: {}, element };
	const kind = element.getAttribute("data-view-kind") ?? "";
	const title = element.getAttribute("data-view-title") ?? "";
	const item = element.getAttribute("data-view-item");
	return {
		kind: "view",
		label: title || kind || "View",
		data: { view, kind, title, ...(item === null ? {} : { item }) },
		element,
	};
}

/** An element's text on one line, cut at `limit` characters. */
function textOf(element: Element | null, limit = 120): string {
	return (element?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** `text` cut at `limit` characters with "…". */
export const excerpt = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

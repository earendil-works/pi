// The artifacts' panes (view kinds `html` and `md`), beside the transcript and inline in it: an html page in its
// sandboxed frame with the page's side of the bridge (`bridge.ts`: its state, selection, errors and logs, the agent's
// code), a Markdown document rendered. Both show the artifact's newest version and follow new ones; a document keeps
// the reader's place across versions.
import { BACKGROUND_CONTEXT, type JsonValue, liveIn } from "@p2/app/v1";
import {
	errorText,
	Markdown,
	type PaneProps,
	useComposerState,
	useObject,
	useReadable,
	useRegistry,
	useStatus,
} from "@p2/app/v1/web";
import { type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ViewsPages } from "../views/contract.web.ts";
import { excerpt, usePaneSelection } from "../views/pane-kit.tsx";
import { VIEW_CHANNEL } from "./bridge.ts";
import { ArtifactPage, type EvalResult, MAX_ARTIFACT_STATE } from "./contract.ts";
import { InlineSizeContext } from "./inline-size.ts";
import { useArtifacts } from "./use-artifacts.ts";

/** How long a frame's state rests before it is saved. */
const STATE_PAUSE = 300;
/** How often what a page reported goes to the server, at most. */
const REPORT_PAUSE = 1000;
/** The tallest an inline page grows to its content, as a share of the window's height. */
const INLINE_MAX = 0.7;

/** A message a frame posted (untrusted: the page's own script can post anything). */
const isMessage = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** A Markdown artifact, rendered; the person's text selection in it is the view's selection. */
export function MdPane({ session, item, inline, select }: PaneProps) {
	const id = item ?? "";
	const text = useArtifactText(session, id);
	const body = useRef<HTMLDivElement>(null);
	const inlineSize = useContext(InlineSizeContext);
	// Beside the transcript the document scrolls itself: a new version keeps what the reader had at the top in place.
	useReadingPlace(body, inline ? undefined : text.value);
	// Inline, the drawn document's height is the card's real height (an error's too).
	useLayoutEffect(() => {
		const element = body.current;
		if (inlineSize && element && (text.value !== undefined || text.error)) inlineSize.report(element.offsetHeight);
	}, [inlineSize, text.value, text.error]);
	usePaneSelection(
		body,
		(quote) => ({ summary: `${excerpt(quote)} in artifact ${id}`, data: { text: quote, artifact: id } }),
		select,
	);
	return (
		<div className={`views-doc artifact-md ${inline ? "inline" : ""}`} ref={body}>
			{text.error ? (
				<div className="notice error">{text.error}</div>
			) : text.value === undefined ? (
				<div className="spinner" />
			) : (
				<Markdown text={text.value} />
			)}
		</div>
	);
}

/**
 * Where the reader is in a document: the block at the top of the pane and the heading above it, each with its offset,
 * at scroll position `scrollTop`.
 */
type ReadingPlace = { readonly scrollTop: number; readonly top?: BlockPlace; readonly heading?: BlockPlace };
/** A block by its tag and text (the `index`th of its kind) and its top relative to the pane's. */
type BlockPlace = { readonly key: string; readonly index: number; readonly offset: number };

/** The blocks a reader's place is kept by, in document order. */
const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table,hr";
const HEADING = /^H[1-6]$/;

/**
 * Keeps the reader's place in a scrolled document when its `text` changes (a new version): the block that was at the
 * top of `scroller`, by tag and text, stays where it was; if that block changed, the heading above it does; if
 * neither is there any more, the scroll position stays. Text inserted above what the reader sees does not move it.
 */
function useReadingPlace(scroller: RefObject<HTMLElement | null>, text: string | undefined): void {
	const place = useRef<ReadingPlace>({ scrollTop: 0 });
	// Noted once per frame of scrolling (it reads every block's text); a scroll since is taken into account below.
	useEffect(() => {
		const element = scroller.current;
		if (!element || text === undefined) return;
		let frame: number | undefined;
		const note = () => {
			frame ??= requestAnimationFrame(() => {
				frame = undefined;
				place.current = readingPlace(element);
			});
		};
		element.addEventListener("scroll", note, { passive: true });
		return () => {
			element.removeEventListener("scroll", note);
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [scroller, text]);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element || text === undefined) return;
		const { scrollTop, top, heading } = place.current;
		// The new blocks are laid out, the scroll position is still the old one (no browser anchoring: artifacts.css).
		const scrolled = element.scrollTop - scrollTop;
		const moved = [top, heading].flatMap((wanted) => {
			const found = wanted && blockAt(element, wanted);
			if (!wanted || !found) return [];
			return [found.getBoundingClientRect().top - element.getBoundingClientRect().top - (wanted.offset - scrolled)];
		})[0];
		if (moved !== undefined && Math.abs(moved) >= 1) element.scrollTop += moved;
		place.current = readingPlace(element);
	}, [scroller, text]);
}

/** The block at the top of `scroller` and the heading at or above it. */
function readingPlace(scroller: HTMLElement): ReadingPlace {
	const top = scroller.getBoundingClientRect().top;
	const blocks = [...scroller.querySelectorAll<HTMLElement>(BLOCKS)];
	const at = blocks.findIndex((block) => block.getBoundingClientRect().bottom > top + 1);
	if (at < 0) return { scrollTop: scroller.scrollTop };
	const placed = (index: number): BlockPlace => {
		const block = blocks[index]!;
		const key = blockKey(block);
		return {
			key,
			index: blocks.slice(0, index).filter((other) => blockKey(other) === key).length,
			offset: block.getBoundingClientRect().top - top,
		};
	};
	const heading = blocks.findLastIndex((block, index) => index <= at && HEADING.test(block.tagName));
	return { scrollTop: scroller.scrollTop, top: placed(at), ...(heading < 0 ? {} : { heading: placed(heading) }) };
}

/** The block `place` names in `scroller`, if the document still has it. */
function blockAt(scroller: HTMLElement, place: BlockPlace): HTMLElement | undefined {
	return [...scroller.querySelectorAll<HTMLElement>(BLOCKS)].filter((block) => blockKey(block) === place.key)[
		place.index
	];
}

const blockKey = (block: HTMLElement) => `${block.tagName}\n${block.textContent?.trim() ?? ""}`;

/**
 * The newest version's text of artifact `id`, read again when a new version appears; meanwhile the version read last
 * stays (the document neither blanks nor loses its scroll position).
 */
function useArtifactText(session: string, id: string): { value?: string; error?: string } {
	const { list, reader } = useArtifacts(session);
	const summary = list?.find((each) => each.id === id);
	const [text, setText] = useState<{ key: string; value?: string; error?: string }>();
	useEffect(() => {
		if (!reader || !summary) return;
		let current = true;
		reader
			.read({ id, version: summary.version }, BACKGROUND_CONTEXT)
			.then((read) => current && setText({ key: `${id}@${read.version}`, value: read.content }))
			.catch((error: unknown) => current && setText({ key: `${id}@${summary.version}`, error: errorText(error) }));
		return () => {
			current = false;
		};
	}, [reader, id, summary]);
	if (list && !summary) return { error: `No artifact "${id}" (it was deleted)` };
	return text?.key.startsWith(`${id}@`) ? text : {};
}

/**
 * An html artifact: its newest version in a sandboxed frame; its state, selection, errors and logs through the bridge;
 * the agent's code run in it while it is shown. Inline (in the transcript) it grows to its content's height.
 */
export function HtmlPane({ session, item, inline, view, editable, select, annotations }: PaneProps) {
	const id = item ?? "";
	const frame = useRef<HTMLIFrameElement>(null);
	const page = useObject(ArtifactPage, { session, id });
	useStatus(page);
	const summary = useReadable(page?.summary);
	const value = useReadable(page?.value);
	const writer = liveIn(page, "editor");
	const live = writer ?? liveIn(page, "viewer");
	const { fail } = useComposerState();
	const inlineSize = useContext(InlineSizeContext);
	// Inline, the frame starts at the height it last had (the page reports its own once it loads).
	const [height, setHeight] = useState<number | undefined>(inlineSize?.initial);
	/** The JSON the frame last saved: coming back from the server, it is not sent to the frame again. */
	const own = useRef<string | undefined>(undefined);
	const ready = useRef(false);
	const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; value?: JsonValue }>({});
	const regions = useRef(new Map<string, (text: string) => void>());
	const lastSelection = useRef("");
	const reported = useRef<{
		errors: string[];
		logs: { level: string; text: string }[];
		timer?: ReturnType<typeof setTimeout>;
	}>({ errors: [], logs: [] });
	const paneKey = view?.id ?? `inline:${id}`;

	const post = useCallback((message: Record<string, unknown>) => {
		frame.current?.contentWindow?.postMessage({ channel: VIEW_CHANNEL, ...message }, "*");
	}, []);
	const quotes = annotations
		.filter((annotation) => annotation.quote && annotation.kind !== "ink")
		.map((annotation) => ({ text: annotation.quote, kind: annotation.kind }));
	const quotesJson = JSON.stringify(quotes);

	const sendState = useCallback(
		(from: "init" | "update") => {
			if (value === undefined) return;
			post({ type: "state", state: value, from, readOnly: !editable || !writer });
		},
		[post, value, editable, writer],
	);

	// The server's state reaches the frame, unless it is what the frame saved itself.
	useEffect(() => {
		if (!ready.current || value === undefined) return;
		if (JSON.stringify(value) === own.current) return;
		sendState("update");
	}, [value, sendState]);

	useEffect(() => {
		if (ready.current) post({ type: "highlight", quotes: JSON.parse(quotesJson) });
	}, [quotesJson, post]);

	// The agent's code: each request runs in the frame, whose answer goes back to the server (the first page wins).
	const answers = useRef(new Map<string, (result: EvalResult) => void>());
	useEffect(() => {
		if (!live) return;
		let stop: (() => void) | undefined;
		let stopped = false;
		void live.request
			.on(({ value: asked }) => {
				const finish = (result: EvalResult) => {
					answers.current.delete(asked.request);
					live.answer({ request: asked.request, result }, BACKGROUND_CONTEXT).catch(() => {
						// The request was answered already, or the page lost its link: the server's timeout decides.
					});
				};
				if (!ready.current) return finish({ ok: false, error: "The page is still loading" });
				answers.current.set(asked.request, finish);
				post({ type: "eval", id: asked.request, code: asked.code });
			}, BACKGROUND_CONTEXT)
			.then((subscription) => {
				if (stopped) subscription.stop();
				else stop = () => subscription.stop();
			});
		return () => {
			stopped = true;
			stop?.();
		};
	}, [live, post]);

	// Beside the transcript the annotation layer asks the frame what is selected and what lies under a drawing.
	const viewsPage = useRegistry(ViewsPages).get("views");
	useEffect(() => {
		if (!view || !viewsPage) return;
		return viewsPage.frame(view.id, {
			selection: () => lastSelection.current,
			describe: (rect) =>
				new Promise((resolve) => {
					const request = crypto.randomUUID();
					const timer = setTimeout(() => {
						regions.current.delete(request);
						resolve("");
					}, 800);
					regions.current.set(request, (text) => {
						clearTimeout(timer);
						resolve(text);
					});
					post({ type: "describe", id: request, rect });
				}),
		});
	}, [view, viewsPage, post]);

	useEffect(() => {
		const save = () => {
			const next = pending.current.value;
			pending.current = {};
			if (next === undefined || !writer) return;
			writer.setState({ state: next }, BACKGROUND_CONTEXT).catch(fail);
		};
		const flush = () => {
			const { errors, logs } = reported.current;
			reported.current = { errors: [], logs: [] };
			if ((errors.length || logs.length) && live)
				live.report({ errors, logs }, BACKGROUND_CONTEXT).catch(() => {
					// Reports are best effort: a page that lost its link reports its next ones.
				});
		};
		const note = (kind: "errors" | "logs", entry: { level: string; text: string }) => {
			const text = entry.text.slice(0, 4000);
			if (kind === "errors") reported.current.errors.push(text);
			reported.current.logs.push({ level: entry.level.slice(0, 16), text });
			reported.current.errors.splice(0, Math.max(0, reported.current.errors.length - 100));
			reported.current.logs.splice(0, Math.max(0, reported.current.logs.length - 500));
			reported.current.timer ??= setTimeout(() => {
				reported.current.timer = undefined;
				flush();
			}, REPORT_PAUSE);
		};
		const receive = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			const message: unknown = event.data;
			if (!isMessage(message)) return;
			if (message.channel === "p2-artifact-diagnostic") {
				const level = typeof message.level === "string" ? message.level : "";
				const text = typeof message.message === "string" ? message.message : "";
				if (level === "size" && typeof message.height === "number") {
					setHeight(message.height);
					inlineSize?.report(Math.min(message.height, Math.round(window.innerHeight * INLINE_MAX)));
				} else if (level === "error" || level === "csp" || level === "webgl") note("errors", { level, text });
				else if (level === "warn") note("logs", { level, text });
				return;
			}
			if (message.channel !== VIEW_CHANNEL) return;
			switch (message.type) {
				case "hello":
					ready.current = true;
					sendState("init");
					post({ type: "highlight", quotes: JSON.parse(quotesJson) });
					break;
				case "set-state": {
					if (!editable || !writer) return;
					const next = (message.state ?? null) as JsonValue;
					const json = JSON.stringify(next);
					if (json.length > MAX_ARTIFACT_STATE) {
						fail(
							new Error(`The page's state is over ${MAX_ARTIFACT_STATE / 1024} KiB of JSON and was not saved`),
						);
						return;
					}
					own.current = json;
					pending.current.value = next;
					clearTimeout(pending.current.timer);
					pending.current.timer = setTimeout(save, STATE_PAUSE);
					break;
				}
				case "select": {
					if (!editable) return;
					const summary = typeof message.summary === "string" ? message.summary.trim().slice(0, 2000) : "";
					select(summary ? { summary, data: (message.data ?? null) as JsonValue } : null);
					break;
				}
				case "text-selection": {
					const text = typeof message.text === "string" ? message.text.slice(0, 4000) : "";
					lastSelection.current = text;
					viewsPage?.noteSelection(paneKey, text);
					break;
				}
				case "region": {
					const request = typeof message.id === "string" ? message.id : "";
					regions.current.get(request)?.(typeof message.text === "string" ? message.text : "");
					regions.current.delete(request);
					break;
				}
				case "log": {
					const level = typeof message.level === "string" ? message.level : "log";
					note("logs", { level, text: typeof message.text === "string" ? message.text : "" });
					break;
				}
				case "eval-result": {
					const request = typeof message.id === "string" ? message.id : "";
					const finish = answers.current.get(request);
					if (!finish) break;
					finish(
						message.ok === true
							? { ok: true, value: (message.value ?? null) as JsonValue }
							: { ok: false, error: typeof message.error === "string" ? message.error : "The code failed" },
					);
					break;
				}
			}
		};
		window.addEventListener("message", receive);
		return () => {
			window.removeEventListener("message", receive);
			// What the frame changed last is saved, and what it reported sent, not lost with the pane.
			if (pending.current.timer) {
				clearTimeout(pending.current.timer);
				save();
			}
			clearTimeout(reported.current.timer);
			reported.current.timer = undefined;
			flush();
		};
	}, [editable, writer, live, select, sendState, post, quotesJson, fail, paneKey, inlineSize, viewsPage]);

	// A new version is a new page: it says hello again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs for each version of the page.
	useEffect(() => {
		ready.current = false;
	}, [summary?.version]);

	if (summary === null) return <p className="empty-note">No artifact "{id}" (it was deleted).</p>;
	if (!summary) return <div className="spinner" />;
	const url = `/artifact-frame?${new URLSearchParams({ session, id, version: String(summary.version) })}`;
	const maxHeight = typeof window === "undefined" ? 600 : Math.round(window.innerHeight * INLINE_MAX);
	return (
		<iframe
			// A new frame per version: changing a frame's src would add a history entry.
			key={url}
			ref={frame}
			className={`views-frame artifact-frame ${inline ? "inline" : ""}`}
			title={summary.title}
			src={url}
			sandbox="allow-scripts allow-modals allow-pointer-lock"
			referrerPolicy="no-referrer"
			{...(inline ? { style: { height: Math.min(height ?? 240, maxHeight) } } : {})}
		/>
	);
}

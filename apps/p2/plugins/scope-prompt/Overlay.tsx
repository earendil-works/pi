// The scope prompt over the owner's page. In pointing mode (mode.ts: a double tap of Cmd, Cmd+. or the command menu)
// the thing under the pointer is outlined (scopes.ts); a click on it opens a small composer there instead of acting on
// the page. On a touch screen a tap outlines what it is on and a second tap on it (a double tap) opens the composer. What is typed about the open session's page (its chat, a view) goes to the open conversation as the
// person's message, the scope as message context; what is typed about anything else (the sidebar) goes to the Familiar
// with the scope after it, to route (message.ts). The composer's "To" switches between the two.
// Outside the mode the page behaves as before: the overlay draws nothing and takes no events.
import { BACKGROUND_CONTEXT, type Host, withHeld } from "@p2/app/v1";
import { CloseIcon, navigate, type Route, useComposerState, useHost, useOwner, useRoute } from "@p2/app/v1/web";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Chat } from "../chat/contract.ts";
import { FAMILIAR_TITLE, Familiar } from "../familiar/contract.ts";
import { Sessions } from "../sessions/contract.ts";
import { ScopeStage } from "./contract.ts";
import { familiarMessage, inOpenSession, type Scope, scopeBlock, scopeNote } from "./message.ts";
import { setPointing, useModeKeys, usePointing } from "./mode.ts";
import { excerpt, type ScopeLevel, scopesAt } from "./scopes.ts";

/** A pick: the scope chain under the click and where the click was (the composer opens there). */
type Pick = Scope & { readonly x: number; readonly y: number };

/** Where a prompt goes: the open conversation (a target in its page), or the Familiar, which routes it. */
type Destination = "chat" | "familiar";

/** Where a sent prompt went: the open conversation, or the Familiar's (which the note opens). */
type Sent =
	| { readonly kind: "chat" }
	| { readonly kind: "familiar"; readonly session: string; readonly conversation: number };

/** Touch screens: a tap shows the scope, a second tap on it asks. */
const COARSE = matchMedia("(pointer: coarse)");

/** The overlay, for the owner only (it talks to the Familiar, which is the owner's). */
export function ScopePrompt() {
	return useOwner() ? <Overlay /> : null;
}

function Overlay() {
	useModeKeys();
	const pointing = usePointing();
	const [hover, setHover] = useState<readonly ScopeLevel[]>();
	const [pick, setPick] = useState<Pick>();
	const [text, setText] = useState("");
	const [sent, setSent] = useState<Sent>();
	// Where the pointer was last and what it is (a mouse outlines what it is on as soon as the mode starts).
	const point = useRef({ x: -1, y: -1, mouse: true });

	useEffect(() => {
		const track = (event: PointerEvent) => {
			point.current = { x: event.clientX, y: event.clientY, mouse: event.pointerType === "mouse" };
		};
		window.addEventListener("pointermove", track, { capture: true, passive: true });
		window.addEventListener("pointerdown", track, { capture: true, passive: true });
		return () => {
			window.removeEventListener("pointermove", track, { capture: true });
			window.removeEventListener("pointerdown", track, { capture: true });
		};
	}, []);

	useEffect(() => {
		if (!pointing) return;
		let frame = 0;
		// The innermost element outlined now: a tap on it again picks it.
		let shown: Element | undefined;
		const outline = (levels: ScopeLevel[]) => {
			shown = levels.at(-1)?.element;
			setHover(levels.length ? levels : undefined);
		};
		const show = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				// Over the overlay's own controls (its button, the pill, the composer) nothing is outlined: they stay
				// clearly pressable.
				const element = document.elementFromPoint(point.current.x, point.current.y);
				outline(element?.closest(".scope-ui") ? [] : scopesAt(element));
			});
		};
		const choose = (levels: ScopeLevel[], x: number, y: number) => {
			setPointing(false);
			if (!levels.length) return;
			setSent(undefined);
			setPick({ levels, x, y, ...selectionIn(levels.at(-1)?.element) });
		};
		const ours = (event: Event) => event.target instanceof Element && event.target.closest(".scope-ui") !== null;
		const onMove = (event: PointerEvent) => {
			if (event.pointerType === "mouse") show();
		};
		// A mouse picks on press, before the page sees it: no focus change, no text selection starting, no link or button
		// acting. A touch is left to the page until its tap (a drag scrolls as always).
		const onPointerDown = (event: PointerEvent) => {
			if (event.pointerType !== "mouse" || event.button !== 0 || ours(event)) return;
			event.preventDefault();
			event.stopPropagation();
			swallowClick();
			choose(scopesAt(document.elementFromPoint(event.clientX, event.clientY)), event.clientX, event.clientY);
		};
		// A tap outlines what it is on; a tap on what is outlined (a double tap) picks it.
		const onClick = (event: MouseEvent) => {
			if (point.current.mouse || ours(event)) return;
			event.preventDefault();
			event.stopPropagation();
			const levels = scopesAt(document.elementFromPoint(event.clientX, event.clientY));
			if (shown !== undefined && levels.at(-1)?.element === shown) choose(levels, event.clientX, event.clientY);
			else outline(levels);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setPointing(false);
		};
		const stop = () => setPointing(false);
		// Frames would keep the pointer's moves and clicks to themselves: while pointing, a frame is part of its pane.
		document.documentElement.classList.add("scope-pointing");
		if (point.current.mouse) show();
		window.addEventListener("pointermove", onMove, { capture: true, passive: true });
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("click", onClick, true);
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("blur", stop);
		document.addEventListener("visibilitychange", stop);
		return () => {
			cancelAnimationFrame(frame);
			setHover(undefined);
			document.documentElement.classList.remove("scope-pointing");
			window.removeEventListener("pointermove", onMove, { capture: true });
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("click", onClick, true);
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("blur", stop);
			document.removeEventListener("visibilitychange", stop);
		};
	}, [pointing]);

	const close = useCallback(() => {
		setPick(undefined);
		setText("");
	}, []);
	const sentDone = useCallback(() => setSent(undefined), []);
	return (
		<>
			{hover && <Outline level={hover.at(-1)} chain={hover} />}
			{pointing && (
				<output className="scope-mode scope-ui">
					<span>{COARSE.matches ? "Tap to see the scope, tap it again to ask" : "Click what to ask about"}</span>
					{!COARSE.matches && <span className="muted">Esc to stop</span>}
					<button type="button" className="text-action" onClick={() => setPointing(false)}>
						Stop
					</button>
				</output>
			)}
			{pick && (
				<Composer
					key={`${pick.x}:${pick.y}`}
					pick={pick}
					text={text}
					setText={setText}
					onClose={close}
					onSent={(done) => {
						close();
						setSent(done);
					}}
				/>
			)}
			{sent && !pick && <SentNote sent={sent} onDone={sentDone} />}
		</>
	);
}

/**
 * Swallows the click that follows a pick's pointerdown (links and buttons under it must not act); the mode may have
 * ended by then. Gone after that pointer's release, so a click that never comes (the pointer moved off) eats no other.
 */
function swallowClick(): void {
	const swallow = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
	};
	window.addEventListener("click", swallow, { capture: true, once: true });
	window.addEventListener(
		"pointerup",
		// The click is dispatched right after the release, before this timer runs.
		() => setTimeout(() => window.removeEventListener("click", swallow, true)),
		{ capture: true, once: true },
	);
}

/** The outline around `level`'s element, with the chain's labels on its top edge. */
function Outline({ level, chain }: { level: ScopeLevel | undefined; chain: readonly ScopeLevel[] }) {
	const rect = useRect(level?.element);
	if (!rect) return null;
	return (
		<div
			className="scope-outline"
			style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
			aria-hidden="true"
		>
			<span className="scope-outline-label">{chain.map((each) => excerpt(each.label, 32)).join(" › ")}</span>
		</div>
	);
}

/** Where `element` is now, followed every frame while shown (panes scroll and resize under it). */
function useRect(element: Element | undefined): DOMRect | undefined {
	const [rect, setRect] = useState<DOMRect>();
	useEffect(() => {
		if (!element) {
			setRect(undefined);
			return;
		}
		let frame = 0;
		const follow = () => {
			const next = element.getBoundingClientRect();
			setRect((last) =>
				last &&
				last.left === next.left &&
				last.top === next.top &&
				last.width === next.width &&
				last.height === next.height
					? last
					: next,
			);
			frame = requestAnimationFrame(follow);
		};
		follow();
		return () => cancelAnimationFrame(frame);
	}, [element]);
	return rect;
}

/**
 * The composer at the click: the chain as steps (the chosen one and those around it are sent; a step further out widens
 * the scope), the text, Send. Enter sends, Shift+Enter breaks the line, Escape closes.
 */
function Composer({
	pick,
	text,
	setText,
	onClose,
	onSent,
}: {
	pick: Pick;
	text: string;
	setText: (text: string) => void;
	onClose: () => void;
	onSent: (sent: Sent) => void;
}) {
	const host = useHost();
	const route = useRoute();
	const { fail } = useComposerState();
	const [chosen, setChosen] = useState(pick.levels.length - 1);
	const inChat = inOpenSession(pick, route);
	const [destination, setDestination] = useState<Destination>(inChat ? "chat" : "familiar");
	const [sending, setSending] = useState(false);
	const levels = pick.levels.slice(0, chosen + 1);
	const box = useRef<HTMLFormElement>(null);

	// A click elsewhere closes an empty composer; typed text stays until Escape or Send.
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (!text.trim() && !box.current?.contains(event.target instanceof Node ? event.target : null)) onClose();
		};
		window.addEventListener("pointerdown", outside);
		return () => window.removeEventListener("pointerdown", outside);
	}, [text, onClose]);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!text.trim() || sending) return;
		setSending(true);
		const scope: Scope = { levels, ...(pick.selection ? { selection: pick.selection } : {}) };
		(destination === "chat" ? sendToChat(host, text, scope, route) : sendToFamiliar(host, text, scope, route))
			.then(onSent)
			.catch(fail)
			.finally(() => setSending(false));
	};

	// Below the click when there is room, else above it; inside the window either way.
	const width = Math.min(420, window.innerWidth - 32);
	const left = Math.max(16, Math.min(pick.x - 24, window.innerWidth - width - 16));
	const below = pick.y < window.innerHeight - 240;
	return (
		<>
			<Outline level={pick.levels[chosen]} chain={levels} />
			<form
				ref={box}
				className="scope-composer scope-ui"
				style={{ left, width, ...(below ? { top: pick.y + 16 } : { bottom: window.innerHeight - pick.y + 16 }) }}
				onSubmit={submit}
			>
				<fieldset className="scope-steps" aria-label="Scope">
					{pick.levels.map((level, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: the chain is fixed for the pick.
							key={index}
							type="button"
							className={`scope-step ${index === chosen ? "chosen" : ""} ${index > chosen ? "outside" : ""}`}
							aria-pressed={index === chosen}
							title={level.kind}
							onClick={() => setChosen(index)}
						>
							{excerpt(level.label, 40)}
						</button>
					))}
					<span className="scope-fill" />
					<button type="button" className="icon-button scope-close" aria-label="Close" onClick={onClose}>
						<CloseIcon />
					</button>
				</fieldset>
				{pick.selection && <p className="scope-selection muted">“{excerpt(pick.selection, 140)}”</p>}
				<textarea
					// biome-ignore lint/a11y/noAutofocus: the composer opens for typing.
					autoFocus
					value={text}
					rows={2}
					placeholder={`Ask about ${excerpt(levels.at(-1)?.label ?? "this", 40)}…`}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
						if (event.key === "Escape") onClose();
					}}
				/>
				<div className="scope-foot">
					<fieldset className="scope-destination" aria-label="Send to">
						<span className="muted">To</span>
						{inChat && (
							<button
								type="button"
								className={`scope-step ${destination === "chat" ? "chosen" : ""}`}
								aria-pressed={destination === "chat"}
								onClick={() => setDestination("chat")}
							>
								Chat
							</button>
						)}
						<button
							type="button"
							className={`scope-step ${destination === "familiar" ? "chosen" : ""}`}
							aria-pressed={destination === "familiar"}
							onClick={() => setDestination("familiar")}
						>
							{FAMILIAR_TITLE}
						</button>
					</fieldset>
					<button type="submit" className="text-action" disabled={!text.trim() || sending}>
						{sending ? "Sending…" : "Send"}
					</button>
				</div>
			</form>
		</>
	);
}

/**
 * Sends `text` to the open conversation as the person's message, as its composer does: the scope block is staged on
 * the session first and goes along as message context (the transcript shows the text with a note).
 */
async function sendToChat(host: Host, text: string, scope: Scope, route: Route): Promise<Sent> {
	const context = BACKGROUND_CONTEXT;
	const session = route.session;
	if (session === undefined) throw new Error("No conversation is open");
	const requestId = crypto.randomUUID();
	await withHeld(host.hold(ScopeStage, { session }, context), "sender", (stage) =>
		stage.stage({ requestId, block: scopeBlock(scope), note: scopeNote(scope) }, context),
	);
	await withHeld(host.hold(Chat, { session, conversation: route.conversation }, context), "participant", (chat) =>
		chat.send({ text: text.trim(), requestId }, context),
	);
	return { kind: "chat" };
}

/**
 * Sends `text` with its scope to the Familiar's main conversation (made or restored first, as its logo does), queued
 * after its current run; returns where it went.
 */
async function sendToFamiliar(host: Host, text: string, scope: Scope, route: Route): Promise<Sent> {
	const context = BACKGROUND_CONTEXT;
	const { id } = await withHeld(host.hold(Familiar, {}, context), "owner", (familiar) => familiar.open(context));
	const rows = await withHeld(host.hold(Sessions, {}, context), "owner", async (sessions) => sessions.sessions.value);
	const conversation = rows.find((row) => row.id === id)?.main ?? 1;
	const title = rows.find((row) => row.id === route.session)?.title;
	await withHeld(host.hold(Chat, { session: id, conversation }, context), "participant", (chat) =>
		chat.send(
			{
				text: familiarMessage(text, scope, route, title),
				requestId: crypto.randomUUID(),
				whenBusy: "followUp",
			},
			context,
		),
	);
	return { kind: "familiar", session: id, conversation };
}

/** The page's text selection inside `element`, if there is one. */
function selectionIn(element: Element | undefined): { selection?: string } {
	const selection = getSelection();
	if (!element || !selection?.rangeCount || selection.isCollapsed) return {};
	if (!element.contains(selection.getRangeAt(0).commonAncestorContainer)) return {};
	const text = selection.toString().trim().slice(0, 2000);
	return text ? { selection: text } : {};
}

/** How long "Sent" stays. */
const SENT_FOR = 4000;

/** "Sent to Chat", or "Sent to Ask Pi" with a link that opens it, at the bottom. */
function SentNote({ sent, onDone }: { sent: Sent; onDone: () => void }) {
	useEffect(() => {
		const timer = setTimeout(onDone, SENT_FOR);
		return () => clearTimeout(timer);
	}, [onDone]);
	return (
		<output className="scope-sent scope-ui">
			<span>Sent to {sent.kind === "chat" ? "Chat" : FAMILIAR_TITLE}</span>
			{sent.kind === "familiar" && (
				<button
					type="button"
					className="text-action"
					onClick={() => {
						onDone();
						navigate({ session: sent.session, conversation: sent.conversation });
					}}
				>
					Open
				</button>
			)}
		</output>
	);
}

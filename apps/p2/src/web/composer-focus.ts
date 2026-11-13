// Who focuses the composer's textarea: actions that ask for it now (a reply, restored text, dropped files), and opening
// a conversation, whose composer takes the focus once its screen shows, unless a touch opened it (that would open the
// keyboard; a tap on the composer does).
import type { Route } from "./navigation.ts";

/** A conversation whose composer an open focuses. */
export type ComposerTarget = Pick<Route, "session" | "conversation">;

/** A screen's key: its conversation's, or "new" for the new-session screen. */
export function conversationKey(route: ComposerTarget): string {
	return route.session ? `${route.session}:${route.conversation}` : "new";
}

/** One open's request: the conversation it opens and the screen shown at the press. */
type Request = { readonly key: string; readonly from: string | undefined };

/**
 * The composer's textarea, the screen the chat shows, the person's last input and the pending open's focus; one per
 * page (`ComposerState`).
 */
export class ComposerFocus {
	#textarea: HTMLTextAreaElement | null = null;
	#shown: string | undefined;
	#touch = false;
	#request: Request | undefined;

	/**
	 * Follows the person's input until the returned stop: whether the last press was a touch (a finger, a pen; a key or a
	 * mouse is not), the interaction modality the browser keeps for itself. A press or a key also ends a pending open:
	 * the press that opened it came first, a later one is the person's next action.
	 */
	readonly listen = (): (() => void) => {
		const pressed = (event: PointerEvent) => {
			this.#touch = event.pointerType !== "mouse";
			this.#request = undefined;
		};
		const typed = () => {
			this.#touch = false;
			this.#request = undefined;
		};
		document.addEventListener("pointerdown", pressed, { capture: true });
		document.addEventListener("keydown", typed, { capture: true });
		return () => {
			document.removeEventListener("pointerdown", pressed, { capture: true });
			document.removeEventListener("keydown", typed, { capture: true });
		};
	};

	/** The textarea's callback ref. */
	readonly register = (element: HTMLTextAreaElement | null): void => {
		this.#textarea = element;
	};

	/** Focuses the composer now, for an action in the conversation shown. */
	readonly focus = (): void => {
		this.#textarea?.focus();
	};

	/**
	 * Focuses `target`'s composer once its screen shows (`shown`), unless a touch asked. Call it in the press's handler,
	 * before the navigation, also one that waits for the server first. The request ends when its screen shows (with a
	 * composer or without), when another screen does, at the next request, at the person's next press or key (an open
	 * arriving late never takes the focus from what they do then), or on the returned cancel (the server refused).
	 */
	readonly focusWhenOpen = (target: ComposerTarget): (() => void) => {
		this.#request = undefined;
		if (this.#touch) return () => {};
		const request: Request = { key: conversationKey(target), from: this.#shown };
		this.#request = request;
		// Already shown (the open session's row again): its screen does not change.
		if (this.#shown === request.key) this.shown(request.key);
		return () => {
			if (this.#request === request) this.#request = undefined;
		};
	};

	/**
	 * The chat shows `screen` (`conversationKey`; undefined: no chat screen, a list page), after the commit that put its
	 * composer, or none, in place: the request for it focuses that composer.
	 */
	readonly shown = (screen: string | undefined): void => {
		this.#shown = screen;
		const request = this.#request;
		// The screen shown at the press renders again until the navigation arrives; without a chat screen, nothing shows.
		if (!request || screen === undefined || (screen === request.from && screen !== request.key)) return;
		if (screen === request.key) this.#textarea?.focus();
		this.#request = undefined;
	};
}

// The scope prompt's pointing mode: on, what the pointer is on is outlined and a click picks it; off, the page is left
// alone. It is switched by a double tap of the platform's primary modifier (Cmd on macOS, Ctrl elsewhere), by the key
// binding `p2.scope-prompt.toggle` (Cmd+.) and by the command menu's "Prompt anywhere"; holding the modifier does
// nothing, so Cmd+click keeps opening links in new tabs.
import { matchesBinding } from "@p2/app/v1/web";
import { useEffect, useSyncExternalStore } from "react";

let on = false;
const listeners = new Set<() => void>();

/** Switches the mode on or off. */
export function setPointing(next: boolean): void {
	if (next === on) return;
	on = next;
	for (const listener of listeners) listener();
}

/** Whether the mode is on, re-rendering when it switches. */
export function usePointing(): boolean {
	return useSyncExternalStore(subscribe, () => on);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MODIFIER = MAC ? "Meta" : "Control";

/** A tap: the modifier pressed and released within this time. */
const TAP = 300;
/** A double tap: the second tap released within this time of the first. */
const DOUBLE = 450;

/**
 * Switches the mode on the page's keys while mounted: a double tap of the bare modifier (another key, a click or the
 * window losing focus in between cancels it, so Cmd+V, Cmd+click or a tool sending keys never counts), or the binding.
 */
export function useModeKeys(): void {
	useEffect(() => {
		let downAt: number | undefined;
		let tappedAt: number | undefined;
		const reset = () => {
			downAt = undefined;
			tappedAt = undefined;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === MODIFIER && !event.repeat && !event.altKey && !event.shiftKey) {
				downAt = event.timeStamp;
				return;
			}
			reset();
			if (!event.isComposing && !event.repeat && matchesBinding(event, "p2.scope-prompt.toggle")) {
				event.preventDefault();
				setPointing(!on);
			}
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key !== MODIFIER || downAt === undefined) return;
			const tap = event.timeStamp - downAt < TAP;
			downAt = undefined;
			if (!tap) return reset();
			if (tappedAt !== undefined && event.timeStamp - tappedAt < DOUBLE) {
				reset();
				setPointing(!on);
			} else tappedAt = event.timeStamp;
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("pointerdown", reset, true);
		window.addEventListener("blur", reset);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("pointerdown", reset, true);
			window.removeEventListener("blur", reset);
		};
	}, []);
}

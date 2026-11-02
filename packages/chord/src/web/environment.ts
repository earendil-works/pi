/// <reference lib="dom" />
// The page's environment for the connection loop (slice 11 §2, decision "Slice 11, P6"): the clock and timers, and
// the wakes that mean the page may have been away: visible again, back online, restored from the back/forward cache,
// or a network change (Chromium reports it; the old socket then looks fine until it is checked).

import type { LoopEnvironment } from "../surfaces/index.ts";

/** The browser page's loop environment. */
export function pageEnvironment(): LoopEnvironment {
	return {
		now: () => Date.now(),
		after: (ms, callback) => {
			const timer = setTimeout(callback, ms);
			return () => clearTimeout(timer);
		},
		online: () => navigator.onLine,
		onWake: (listener) => {
			const restored = (event: PageTransitionEvent): void => {
				if (event.persisted) listener();
			};
			const visible = (): void => {
				if (document.visibilityState === "visible") listener();
			};
			const network = (navigator as { readonly connection?: EventTarget }).connection;
			window.addEventListener("online", listener);
			window.addEventListener("pageshow", restored);
			document.addEventListener("visibilitychange", visible);
			network?.addEventListener("change", listener);
			return () => {
				window.removeEventListener("online", listener);
				window.removeEventListener("pageshow", restored);
				document.removeEventListener("visibilitychange", visible);
				network?.removeEventListener("change", listener);
			};
		},
	};
}

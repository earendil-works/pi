// React bindings (slice 11 §3, decision "Slice 11, P7"; p2's `useObject`, `useReadable`, `useRegistry`): a host in
// context, references held for a component's life, watchables read with `useSyncExternalStore`, event members
// subscribed while mounted, page state kept for the host's life, and a plugin's messages in the host's language. A
// component unmounted by a reload has not left (design §21): its releases are plain releases, presence is the app's. A component of a reloaded plugin is a new
// function and remounts, its `useState` starting over; what must survive is page state (decision "Tutorial gaps" (1)).
// No components, no styling.

import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { Contract, EventMember, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { canonicalJson } from "../data/principal.ts";
import type { Held, Host, RefState } from "../host/index.ts";
import type { Registry } from "../registries/index.ts";
import { hostLanguage, type Messages, type Translator } from "../surfaces/index.ts";
import { pageState } from "../surfaces/page-state.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";
import { watchStore } from "./stores.ts";

/** The host components use, given by `HostProvider`. */
const HostContext = createContext<Host<Principal> | undefined>(undefined);

/** Gives `host` to the components below. */
export function HostProvider<P extends Principal>(props: { readonly host: Host<P>; readonly children?: ReactNode }) {
	// Components hold for the app's principal type: the context keeps it as the host was given.
	return createElement(HostContext.Provider, { value: props.host as unknown as Host<Principal> }, props.children);
}

/** The host `HostProvider` gives; throws outside one. */
export function useHost<P extends Principal = Principal>(): Host<P> {
	const host = useContext(HostContext);
	if (host === undefined) throw new Error("useHost: no HostProvider above this component");
	return host as unknown as Host<P>;
}

/**
 * A reference to `Type` with `params`, held while the component is mounted and released when it unmounts or its params
 * change (compared by value); `undefined` before its first hold (the first render).
 */
export function useHold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> | undefined {
	const host = useHost();
	const key = canonicalJson(params as never, BACKGROUND_CONTEXT);
	const [held, setHeld] = useState<{ readonly key: string; readonly ref: Held<C> } | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `params` by value: an inline object must not re-hold.
	useEffect(() => {
		const ref = host.hold(Type, params, BACKGROUND_CONTEXT);
		setHeld({ key, ref });
		return () => ref.release();
	}, [host, Type, key]);
	return held !== undefined && held.key === key ? held.ref : undefined;
}

/** The current value of `watchable` (a state member, a derive), re-rendering on change; `undefined` while it has none. */
export function useWatch<T>(watchable: Watchable<T> | NativeWatchable<T> | undefined): T | undefined {
	const store = useMemo(() => watchStore(watchable), [watchable]);
	return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/**
 * Subscribes to event member `member` (a reference's, decision "Events: fire-and-forget members") while the component
 * is mounted: each event calls the latest `listener` (a new function per render does not subscribe again); nothing
 * without a member. Events re-render nothing by themselves: the listener decides.
 */
export function useEvents<T>(
	member: EventMember<T> | undefined,
	listener: (event: { readonly value: T; readonly at: number }) => void,
): void {
	const latest = useRef(listener);
	// At the commit (a layout effect, not a passive one): an event delivered between a render's commit and its passive
	// effects (the event flush is a microtask) already calls that render's listener.
	useLayoutEffect(() => {
		latest.current = listener;
	});
	useEffect(() => {
		if (member === undefined) return;
		const abort = new AbortController();
		// Rejected only once released or aborted: nothing to follow then.
		member.on((event) => latest.current(event), withAbortSignal(abort.signal, BACKGROUND_CONTEXT)).catch(() => {});
		return () => abort.abort();
	}, [member]);
}

/** Registry `R`'s composed value on the component's host, re-rendering on change; `undefined` until it is usable. */
export function useRegistry<C, V>(R: Registry<C, V>): V | undefined {
	const host = useHost();
	const [value, setValue] = useState<NativeWatchable<V> | undefined>(undefined);
	useEffect(() => {
		const abort = new AbortController();
		host.registry(R, withAbortSignal(abort.signal, BACKGROUND_CONTEXT)).then(setValue, () => {});
		return () => abort.abort();
	}, [host, R]);
	return useWatch(value);
}

/** The state of `ref` (loading, live, failed, ended), re-rendering on change; `undefined` without a reference. */
export function useRefState(ref: { readonly state: NativeWatchable<RefState> } | undefined): RefState | undefined {
	return useWatch(ref?.state);
}

/**
 * A value the page keeps under `key` for its host's life, not the component's, with its setter (`useState`'s pair): a
 * component remounted by a plugin reload, a new function, finds what it had; a new key starts at `initial`. Any value
 * (it never crosses a link); gone with the page.
 */
export function usePageState<T>(key: string, initial: T): readonly [T, (value: T) => void] {
	const state = pageState(useHost(), key, initial);
	return [useSyncExternalStore(state.subscribe, state.read, state.read), state.set];
}

/**
 * `messages` in the language of the component's host (the user's pick, else the device's, matched against the
 * catalogs), with its locale; re-renders when the locale or a translation changes. Before the host follows a language
 * (`startPage` does), `t` renders the first catalog and `locale` is `undefined`.
 */
export function useMessages<N extends string, M>(
	messages: Messages<N, M>,
): { readonly t: Translator<N, M>; readonly locale: string | undefined } {
	const state = hostLanguage(useHost());
	const language = useSyncExternalStore(state.subscribe, state.read, state.read);
	return useMemo(() => ({ t: messages.in(language), locale: language?.locale }), [messages, language]);
}

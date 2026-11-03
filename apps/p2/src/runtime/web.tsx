// Browser runtime: the client host in React, slots that plugins fill, object hooks, connection state, navigation.

import { type Contract, type Held, isChordError, type ParamsOf } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { NativeWatchable, Watchable } from "@earendil-works/chord/watch";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { clearKept } from "../web/conversation-cache.ts";
import { CloseIcon } from "../web/icons.tsx";
import {
	conversationRoute,
	forgetLastConversation,
	HOME,
	type Layer,
	Navigation,
	type Route,
	useScrollMemory,
} from "../web/navigation.ts";
import { useSheetSwipe } from "../web/sheet-swipe.ts";
import type { Host, VariantOf } from "./chord.ts";

export {
	conversationRoute,
	HOME,
	type Layer,
	NavigationContext,
	type Route,
	useScrollMemory,
} from "../web/navigation.ts";

import { Access } from "./access.ts";
import type { KeyedRegistry } from "./chord.ts";
import { canonicalJson } from "./json.ts";
import { follow, followRegistry, type HeldIn, type HeldRef, statusOf, UI_LINGER } from "./refs.ts";
import { Slots } from "./web-core.ts";

export { Slots, webCoreFacet } from "./web-core.ts";

export const HostContext = createContext<Host | undefined>(undefined);

export function useHost(): Host {
	const host = useContext(HostContext);
	if (host === undefined) throw new Error("no chord2 host in context");
	return host;
}

const EMPTY: ReadonlyMap<string, never> = new Map<string, never>();

/** A keyed registry's composed table (empty until the host published it); re-renders when it changes. */
export function useRegistry<V>(registry: KeyedRegistry<V>): ReadonlyMap<string, V> {
	const host = useHost();
	const [table, setTable] = useState<ReadonlyMap<string, V>>(EMPTY);
	useEffect(() => followRegistry(host, registry, (next) => setTable(next)), [host, registry]);
	return table;
}

/** Renders the component registered for `name`, or `fallback`. */
export function Slot({
	name,
	fallback = null,
	children,
}: {
	name: string;
	fallback?: ReactNode;
	children?: ReactNode;
}) {
	const Component = useRegistry(Slots).get(name);
	return Component ? <Component>{children}</Component> : (children ?? fallback);
}

/**
 * Renders every component registered as `<prefix>:<name>`, in registration order. Several plugins contribute to one
 * place this way, e.g. `sidebar-foot:devices` and `sidebar-foot:providers`.
 */
export function SlotList({ prefix }: { prefix: string }) {
	const table = useRegistry(Slots);
	return (
		<>
			{[...table]
				.filter(([key]) => key.startsWith(`${prefix}:`))
				.map(([key, Component]) => (
					<Component key={key} />
				))}
		</>
	);
}

/** A modal sheet: a bottom sheet on phones, a centred dialog on wide screens. Escape and the scrim close it. */
export function Sheet({
	title,
	onClose,
	className,
	children,
}: {
	title: string;
	onClose: () => void;
	className?: string;
	children: ReactNode;
}) {
	const body = useRef<HTMLDivElement>(null);
	const section = useRef<HTMLElement>(null);
	const scrim = useRef<HTMLButtonElement>(null);
	useScrollMemory(body);
	// Phones: a downward drag on the grip or header closes the sheet (src/web/sheet-swipe.ts).
	useSheetSwipe(section, scrim, onClose);
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);
	// Footer sheets may be mounted inside the translated phone drawer. A portal keeps their fixed layout
	// relative to the viewport, as in Pi Mobile's app-level sheets, instead of the hidden drawer.
	return createPortal(
		<div className="sheet-layer">
			<button type="button" className="scrim" aria-label="Close" onClick={onClose} ref={scrim} />
			<section
				className={`sheet ${className ?? ""}`}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				ref={section}
			>
				<div className="sheet-grip" aria-hidden="true" />
				<header className="sheet-head">
					<h2>{title}</h2>
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close">
						<CloseIcon />
					</button>
				</header>
				<div className="sheet-body" ref={body}>
					{children}
				</div>
			</section>
		</div>,
		document.body,
	);
}

/** Ends that asking again cannot change: a `useObject` reference stays ended after them. */
const refused = (error: unknown): boolean =>
	isChordError(error) &&
	(error.code === "forbidden" || error.code === "invalid" || error.code === "contract_mismatch");

/**
 * Holds `type(params)` while mounted (on the host its contract places it), synchronously (`host.hold`): it may still be
 * loading, and its state reads as `undefined` in `useReadable` until it is live. Different params or another host
 * release it and hold anew; an unmount releases it after its type's linger (`UI_LINGER`: a conversation stays held a
 * while, so switching back is instant). A reference that ends but not by a refusal (archive, a revoked grant renewed)
 * is replaced by a fresh one after a short delay. `undefined` when `params` is undefined. With `variant`, `undefined`
 * unless the reference is live in that variant (and typed as it).
 */
export function useObject<C extends Contract>(type: C, params: ParamsOf<C> | undefined): Held<C> | undefined;
export function useObject<C extends Contract, const V extends VariantOf<C>>(
	type: C,
	params: ParamsOf<C> | undefined,
	options: { readonly variant: V },
): HeldIn<C, V & string> | undefined;
export function useObject<C extends Contract>(
	type: C,
	params: ParamsOf<C> | undefined,
	options: { readonly variant?: string } = {},
): Held<C> | undefined {
	const host = useHost();
	const key = params === undefined ? undefined : canonicalJson(params);
	const [state, setState] = useState<{ key: string | undefined; ref: Held<C> | undefined }>({
		key: undefined,
		ref: undefined,
	});
	const [, setTick] = useState(0);
	const variant = options.variant;
	// biome-ignore lint/correctness/useExhaustiveDependencies: key includes params by value; inline params objects must not release/reacquire the reference every render.
	useEffect(() => {
		if (key === undefined || params === undefined) {
			setState({ key, ref: undefined });
			return;
		}
		let current = true;
		let ref: Held<C> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stop = (): void => {};
		const acquire = (): void => {
			stop();
			if (ref) UI_LINGER.release(ref, type.name);
			const acquired = host.hold(type, params, BACKGROUND_CONTEXT);
			ref = acquired;
			setState({ key, ref: acquired });
			stop = follow(acquired.state, (next) => {
				if (!current || acquired !== ref) return;
				setTick((tick) => tick + 1);
				if (next.kind === "ended" && !refused(next.error)) timer = setTimeout(() => current && acquire(), 500);
			});
		};
		acquire();
		return () => {
			current = false;
			clearTimeout(timer);
			stop();
			if (ref) UI_LINGER.release(ref, type.name);
		};
	}, [host, type, key]);
	const ref = state.key === key ? state.ref : undefined;
	if (variant !== undefined && (ref === undefined || statusOf(ref) !== "live" || ref.variant !== variant))
		return undefined;
	return ref;
}

/**
 * The value of a watchable (a reference's state member, a derive), re-rendering on change. `undefined` while it cannot
 * be read (its reference is still loading, the member is outside the variant, the reference ended): nothing throws
 * during render.
 */
export function useReadable<T>(readable: Watchable<T> | NativeWatchable<T> | undefined): T | undefined {
	const subscribe = useCallback(
		(onChange: () => void) => (readable === undefined ? () => {} : follow(readable, () => onChange())),
		[readable],
	);
	const read = useCallback(() => readValue(readable), [readable]);
	return useSyncExternalStore(subscribe, read, read);
}

/** A watchable's value, or `undefined` while it cannot be read (not bound, outside the variant, ended). */
export function readValue<T>(readable: Watchable<T> | NativeWatchable<T> | undefined): T | undefined {
	if (readable === undefined) return undefined;
	try {
		return readable.value;
	} catch {
		return undefined;
	}
}

/** The state kind of a reference (`loading`, `live`, `failed`, `ended`), re-rendering on change. */
export function useStatus(ref: HeldRef | undefined): string | undefined {
	return useReadable(ref?.state)?.kind;
}

// ─── connection ───

type ConnectionState = { readonly connected: boolean };
let connection: ConnectionState = { connected: false };
const connectionListeners = new Set<() => void>();

export function setConnected(connected: boolean): void {
	if (connection.connected === connected) return;
	connection = { connected };
	for (const listener of connectionListeners) listener();
}

export function useConnected(): boolean {
	return useSyncExternalStore(
		(listener) => {
			connectionListeners.add(listener);
			return () => connectionListeners.delete(listener);
		},
		() => connection.connected,
	);
}

// ─── a guest's share that ended ───

let shareEnded = false;
const shareEndedListeners = new Set<() => void>();

/** A guest's access ended (link reset, removal, archive): the page stops reconnecting and shows Pi Mobile's notice. */
export function setShareEnded(ended: boolean): void {
	if (shareEnded === ended) return;
	shareEnded = ended;
	for (const listener of shareEndedListeners) listener();
}

export function useShareEnded(): boolean {
	return useSyncExternalStore(
		(listener) => {
			shareEndedListeners.add(listener);
			return () => shareEndedListeners.delete(listener);
		},
		() => shareEnded,
	);
}

// ─── navigation ───

let navigation: Navigation | undefined;

/** One browser navigation service, shared by all plugin components. */
export function getNavigation(): Navigation {
	navigation ??= new Navigation();
	return navigation;
}

export function startNavigation(): () => void {
	getNavigation();
	return () => {
		navigation?.dispose();
		navigation = undefined;
	};
}

export function useNavigation(): Navigation {
	return getNavigation();
}

export function useRoute(): Route {
	const nav = getNavigation();
	return useSyncExternalStore(nav.subscribe, nav.snapshot, nav.snapshot);
}

/** Conversation destinations close modal layers and carry open workspace/terminal panels. */
export function navigate(next: Partial<Route>, options: { replace?: boolean } = {}): void {
	const nav = getNavigation();
	const destination = next.layers
		? { ...HOME, ...next }
		: conversationRoute(nav.route, next.session, next.conversation ?? 1);
	if (options.replace) void nav.replace(destination);
	else if (next.layers) void nav.push(destination);
	else void nav.closeThenPush(() => destination);
}

/** Named plugin modal: locators are small serialized values, not component state. */
export function openLayer(layer: Layer, options: { fromDrawer?: boolean } = {}): void {
	const nav = getNavigation();
	if (options.fromDrawer) void nav.closeThenPush((route) => ({ ...route, layers: [layer] }));
	else void nav.push({ ...nav.route, layers: [...nav.route.layers, layer] });
}

export function closeLayers(): void {
	void getNavigation().close((route) => ({ ...route, layers: [] }));
}

export function setDrawer(open: boolean): void {
	if (open) openLayer({ kind: "drawer" });
	else closeLayers();
}

export function useDrawer(): boolean {
	return useRoute().layers.at(-1)?.kind === "drawer";
}

/** The top layer when it is the sheet (or viewer) `name`, with its locator; undefined otherwise. */
export function useSheet(
	name: string,
	kind: "sheet" | "viewer" = "sheet",
): Exclude<Layer, { kind: "drawer" }> | undefined {
	const top = useRoute().layers.at(-1);
	return top?.kind === kind && top.name === name ? top : undefined;
}

/** Where the browser remembers that it was the owner, for its next start (a UI hint: the server decides access). */
const OWNER_KEY = "p2-owner";

function storedOwner(): boolean {
	try {
		return localStorage.getItem(OWNER_KEY) === "1";
	} catch {
		return false;
	}
}

/** Whether this page is the owner, as the server last said (or a previous page did); undefined before either. */
let ownerKnown: boolean | undefined;

/**
 * Whether the browser is the owner: as its Access object last said while live. Kept while the connection is lost and
 * the object reconnects, and across starts, so the owner's controls (the composer above all) are usable before the
 * connection is: sending waits in the outbox. When the server says otherwise, the conversations kept on this device
 * (`conversation-cache.ts`) are forgotten with it.
 */
export function useOwner(): boolean {
	const access = useObject(Access, {});
	const live = useStatus(access) === "live" && access !== undefined;
	ownerKnown ??= storedOwner();
	const owner = live ? access.variant === "owner" : ownerKnown;
	useEffect(() => {
		if (!live || owner === ownerKnown) return;
		ownerKnown = owner;
		try {
			if (owner) localStorage.setItem(OWNER_KEY, "1");
			else localStorage.removeItem(OWNER_KEY);
		} catch {}
		if (!owner) void clearKept();
	}, [live, owner]);
	return owner;
}

/** Forgets what this browser keeps for the owner: signing out. The kept app (public/sw.js) goes too. */
export async function forgetOwner(): Promise<void> {
	ownerKnown = false;
	try {
		localStorage.removeItem(OWNER_KEY);
	} catch {}
	forgetLastConversation();
	await clearKept();
	try {
		for (const name of await caches.keys()) if (name.startsWith("p2-app-")) await caches.delete(name);
	} catch {}
}

/** A home directory shown as `~` (Termux and Linux homes). */
export function shortPath(path: string): string {
	return path.replace(/^\/data\/data\/com\.termux\/files\/home/, "~").replace(/^\/home\/[^/]+/, "~");
}

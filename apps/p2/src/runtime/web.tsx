// Browser runtime: the client host in React, slots that plugins fill, object hooks, connection state, navigation.

import type { Contract, Held, ParamsOf } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { NativeWatchable, Watchable } from "@earendil-works/chord/watch";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useOptimistic,
	useRef,
	useState,
	useSyncExternalStore,
	useTransition,
} from "react";
import { createPortal } from "react-dom";
import { clearKept } from "../web/conversation-cache.ts";
import { ChevronIcon, CloseIcon } from "../web/icons.tsx";
import {
	conversationRoute,
	forgetLastConversation,
	HOME,
	type Layer,
	Navigation,
	type Route,
	useScrollMemory,
} from "../web/navigation.ts";
import { type SettingsEmbed, useSettingsEmbed } from "../web/settings-embed.ts";
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

import { Access, grantMode } from "./access.ts";
import type { KeyedRegistry } from "./chord.ts";
import { canonicalJson } from "./json.ts";
import { follow, followRegistry, type HeldIn, type HeldRef, knownRegistry, liveIn, UI_LINGER } from "./refs.ts";
import { Slots } from "./web-core.ts";

export { shortPath } from "../web/path-label.ts";
export { type SettingsSection, SettingsSections, Slots, ToolActivities, webCoreFacet } from "./web-core.ts";

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
	// The table known already, at once: a slot mounted with an empty table renders its children unwrapped first, and
	// wrapping them a render later would mount them again (losing their state and focus).
	const [table, setTable] = useState<ReadonlyMap<string, V>>(() => knownRegistry(host, registry) ?? EMPTY);
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
 * place this way, e.g. `composer:voice` and `composer:chat-mode`.
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

/** Modal layers on screen now (`Sheet`, `ViewerShell`): a route layer without one shows nothing. */
let shownModals = 0;

/** Counts the caller as a modal layer on screen while it is mounted. */
export function useShownModal(): void {
	useLayoutEffect(() => {
		shownModals++;
		return () => {
			shownModals--;
		};
	}, []);
}

/** Whether a modal layer (a sheet, a viewer) is on screen. */
export const modalShown = (): boolean => shownModals > 0;

/** How long a route's top layer may show nothing before it is dropped (its code may still be rendering it). */
const UNSHOWN_LAYER_MS = 1500;

/**
 * Drops a top sheet or viewer layer that nothing shows: a route restored by a reload whose new code no longer has what
 * the layer named (a run's sheet whose row changed, a notice's details), or a plugin that is gone. Such a layer would
 * stay invisible yet hold the route: Back would close nothing, and the drawer's swipe, which waits for open layers to
 * close, would never start. Mounted once, by the app's layout.
 */
export function useUnshownLayers(): void {
	const route = useRoute();
	useEffect(() => {
		const top = route.layers.at(-1);
		if (!top || top.kind === "drawer") return;
		const timer = setTimeout(() => {
			if (modalShown()) return;
			// Only this route: a navigation queued meanwhile wins (`replace` with the expected route).
			void getNavigation().replace({ ...route, layers: route.layers.slice(0, -1) }, route);
		}, UNSHOWN_LAYER_MS);
		return () => clearTimeout(timer);
	}, [route]);
}

type SheetProps = {
	title: string;
	onClose: () => void;
	onBack?: () => void;
	className?: string;
	testId?: string;
	children: ReactNode;
};

/**
 * A modal sheet: a bottom sheet on phones, a centred dialog on wide screens. Escape and the scrim close it. `onBack`: a
 * page inside the sheet (a step's detail) has a Back control before its title, which leads to the page under it.
 * While the Settings window shows a section (src/web/settings-embed.ts), the sheet is that section's page instead.
 */
export function Sheet(props: SheetProps) {
	const embed = useSettingsEmbed();
	return embed ? <SettingsPage {...props} embed={embed} /> : <ModalSheet {...props} />;
}

/** A sheet that is always modal, never a page of the Settings window: the Settings window itself. */
export function ModalSheet({ title, onClose, onBack, className, testId, children }: SheetProps) {
	const body = useRef<HTMLDivElement>(null);
	const section = useRef<HTMLElement>(null);
	const scrim = useRef<HTMLButtonElement>(null);
	useShownModal();
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
				data-testid={testId}
				ref={section}
			>
				<div className="sheet-grip" aria-hidden="true" />
				<header className={`sheet-head ${onBack ? "has-back" : ""}`}>
					{onBack && (
						<button type="button" className="icon-button back" onClick={onBack} aria-label="Back">
							<ChevronIcon size={18} />
						</button>
					)}
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

/**
 * A sheet as a page of the Settings window, in its content pane: the window is the modal (its × and Escape close
 * everything), so the page has only its title and, inside a section or on phones, Back.
 */
function SettingsPage({ title, onBack, className, testId, children, embed }: SheetProps & { embed: SettingsEmbed }) {
	const body = useRef<HTMLDivElement>(null);
	useScrollMemory(body);
	const back = onBack ?? embed.back;
	return createPortal(
		<section className={`settings-page ${className ?? ""}`} aria-label={title} data-testid={testId}>
			<header className={`settings-page-head ${back ? "has-back" : ""}`}>
				{back && (
					<button type="button" className="icon-button back" onClick={back} aria-label="Back">
						<ChevronIcon size={18} />
					</button>
				)}
				<h2>{title}</h2>
			</header>
			{/* `sheet-body` too: a plugin's styles for its sheet's body apply to the page as well. */}
			<div className="sheet-body settings-page-body" ref={body}>
				{children}
			</div>
		</section>,
		embed.element,
	);
}

/**
 * Holds `type(params)` while mounted (on the host its contract places it), synchronously (`host.hold`): it may still be
 * loading, and its state reads as `undefined` in `useReadable` until it is live. Chord rebinds it by itself (a dropped
 * link, a restarted worker, a reload). Different params or another host release it and hold anew; an unmount releases
 * it after its type's linger (`UI_LINGER`: a conversation stays held a while, so switching back is instant).
 * `undefined` when `params` is undefined. With `variant`, `undefined` unless the reference is live in that variant (and
 * typed as it).
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: key includes params by value; inline params objects must not release/reacquire the reference every render.
	useEffect(() => {
		if (key === undefined || params === undefined) {
			setState({ key, ref: undefined });
			return;
		}
		const ref = host.hold(type, params, BACKGROUND_CONTEXT);
		setState({ key, ref });
		return () => UI_LINGER.release(ref, type.name);
	}, [host, type, key]);
	const ref = state.key === key ? state.ref : undefined;
	// Re-renders when the reference goes live, fails or ends: `variant` and `liveIn` read its state.
	const status = useStatus(ref);
	if (options.variant !== undefined && (ref === undefined || status !== "live" || ref.variant !== options.variant))
		return undefined;
	return ref;
}

/**
 * Optimistic UI (docs/optimistic-ui.md): `value` as shown with the guesses of this component's calls in flight, with
 * React's `useOptimistic`. `run(guess, call)` shows `apply(value, guess)` at once and keeps it until `call` settles.
 * Chord applies the state the answering host committed before it sends the answer, so the real value has replaced
 * the guess when it goes; a call that fails drops its guess (the value rolls back) and `onError` says why. `pending`:
 * a call is in flight (long work shows that instead of a guess).
 */
export function useOptimisticCall<T, G>(
	value: T,
	apply: (value: T, guess: G) => T,
	onError: (error: unknown) => void,
): readonly [shown: T, run: (guess: G, call: () => Promise<unknown>) => void, pending: boolean] {
	const [shown, add] = useOptimistic(value, apply);
	const [pending, start] = useTransition();
	const run = useCallback(
		(guess: G, call: () => Promise<unknown>) =>
			start(async () => {
				add(guess);
				try {
					await call();
				} catch (error) {
					onError(error);
				}
			}),
		[add, onError],
	);
	return [shown, run, pending] as const;
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

/**
 * Whether this browser may write in `session` (send, stop, the workspace): the owner as last known (`useOwner`, so no
 * wait for `Access`), or a guest whose grant gives it full access there.
 */
export function useCanWrite(session: string | undefined): boolean {
	const owner = useOwner();
	const grant = useReadable(liveIn(useObject(Access, {}), "guest")?.grant);
	return owner || grantMode(grant, session) === "full";
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

/** A failure's message as the UI shows it (a ChordError's message, a thrown string). */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

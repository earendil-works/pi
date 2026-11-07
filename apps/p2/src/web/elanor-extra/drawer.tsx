// Elanor's Drawer with what its npm release (0.1.0) does not have yet, built in p2: a bottom sheet's drag to close
// with a rubber band (sheet-drag.ts) and its grip, and a stack of pages (Drawer.Stack, Drawer.Page) with swipe back
// (swipe-back.ts). Ported from Elanor's source as vendored on the p2-elanor branch, on top of the npm release's
// Drawer; styles in elanor-extra.css. Replace with Elanor's Drawer once it ships these; the props are the same.
import { ChevronLeftIcon, CloseIcon } from "@earendil-works/elanor-icons-react";
import {
	type DrawerBackdropProps,
	type DrawerContentProps,
	type DrawerPopupProps,
	type DrawerRootProps,
	Drawer as ElanorDrawer,
	IconButton,
} from "@earendil-works/elanor-react";
import {
	Children,
	type ComponentPropsWithRef,
	createContext,
	isValidElement,
	type ReactElement,
	type ReactNode,
	type Ref,
	type UIEvent,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { attachSheetDrag } from "./sheet-drag.ts";
import { attachSwipeBack } from "./swipe-back.ts";
import "./elanor-extra.css";

type SheetState = {
	/** A bottom sheet without snap points: dragged away by sheet-drag.ts rather than Base UI's swipe. */
	drag: boolean;
	close: () => void;
	backdrop: () => HTMLElement | null;
	setBackdrop: (element: HTMLElement | null) => void;
	onClosed: (callback: () => void) => () => void;
};
const SheetContext = createContext<SheetState | null>(null);
/** The popup element, for parts that listen to gestures on it (Drawer.Stack's swipe back). */
const PopupContext = createContext<HTMLElement | null>(null);

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
	if (typeof ref === "function") ref(value);
	else if (ref) (ref as { current: T | null }).current = value;
}

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");
const mergeClassName = <State,>(own: string, className: string | ((state: State) => string | undefined) | undefined) =>
	typeof className === "function" ? (state: State) => classes(own, className(state)) : classes(own, className);

/**
 * Groups the drawer's parts and holds its open state. A bottom sheet without snap points is dragged away through a
 * rubber band: it closes past a share of its height or on a clear flick, and otherwise springs back.
 */
function DrawerRoot({ actionsRef, onOpenChangeComplete, ...props }: DrawerRootProps) {
	type Actions = { unmount: () => void; close: () => void };
	const actions = useRef<Actions | null>(null);
	useImperativeHandle(
		actionsRef as Ref<Actions> | undefined,
		() => ({ unmount: () => actions.current?.unmount(), close: () => actions.current?.close() }),
		[],
	);
	const backdrop = useRef<HTMLElement | null>(null);
	const closed = useRef(new Set<() => void>());
	const drag = (props.swipeDirection ?? "down") === "down" && !props.snapPoints;
	const context = useMemo<SheetState>(
		() => ({
			drag,
			close: () => actions.current?.close(),
			backdrop: () => backdrop.current,
			setBackdrop: (element) => {
				backdrop.current = element;
			},
			onClosed: (callback) => {
				const callbacks = closed.current;
				callbacks.add(callback);
				return () => callbacks.delete(callback);
			},
		}),
		[drag],
	);
	return (
		<SheetContext value={context}>
			<ElanorDrawer.Root
				{...props}
				actionsRef={actions as DrawerRootProps["actionsRef"]}
				onOpenChangeComplete={(open) => {
					if (!open) for (const callback of closed.current) callback();
					onOpenChangeComplete?.(open);
				}}
			/>
		</SheetContext>
	);
}

function DrawerBackdrop({ ref, className, ...props }: DrawerBackdropProps) {
	const sheet = useContext(SheetContext);
	const backdropRef = useCallback(
		(element: HTMLDivElement | null) => {
			sheet?.setBackdrop(element);
			setRef(ref, element);
		},
		[sheet, ref],
	);
	return (
		<ElanorDrawer.Backdrop {...props} ref={backdropRef} className={mergeClassName("el-drawer-backdrop", className)} />
	);
}

/** The drawer's panel. A bottom sheet (`swipeDirection="down"`) shows a grip at its top edge, a cue to drag it away. */
function DrawerPopup({ ref, className, children, ...props }: DrawerPopupProps) {
	const sheet = useContext(SheetContext);
	const [popup, setPopup] = useState<HTMLDivElement | null>(null);
	const popupRef = useCallback(
		(element: HTMLDivElement | null) => {
			setPopup(element);
			setRef(ref, element);
		},
		[ref],
	);
	useEffect(() => {
		if (!popup || !sheet?.drag) return undefined;
		const detach = attachSheetDrag(popup, { backdrop: sheet.backdrop, close: sheet.close });
		const unsubscribe = sheet.onClosed(() => {
			popup.style.removeProperty("--drawer-drag");
			sheet.backdrop()?.style.removeProperty("--drawer-drag-progress");
		});
		return () => {
			detach();
			unsubscribe();
		};
	}, [popup, sheet]);
	return (
		<ElanorDrawer.Popup
			{...props}
			ref={popupRef}
			{...(sheet?.drag ? { "data-base-ui-swipe-ignore": "" } : {})}
			className={mergeClassName("el-drawer-popup", className)}
		>
			<span className="el-drawer-grip" aria-hidden="true" />
			<PopupContext value={popup}>{children as ReactNode}</PopupContext>
		</ElanorDrawer.Popup>
	);
}

/** The page below's dimming while covered. */
const DIM = 0.12;
/** A completed swipe has less way to go: it finishes faster. */
const SWIPE_FINISH = 0.75;
/** How close to the end (px) still counts as reading the end. */
const END = 96;

/** Parses a CSS time such as `450ms` or `0.45s` into milliseconds. */
function milliseconds(value: string): number {
	const time = Number.parseFloat(value);
	if (Number.isNaN(time)) return 0;
	return value.trim().endsWith("ms") ? time : time * 1000;
}

/**
 * A transition token's duration and easing: `semantic.transition.movement.drawer` (instant when the reader prefers
 * reduced motion) for sliding pages, `semantic.transition.fade` for fading ones.
 */
function motion(element: HTMLElement, token = "movement-drawer") {
	const style = getComputedStyle(element);
	return {
		duration: milliseconds(style.getPropertyValue(`--semantic-transition-${token}-duration`)),
		easing: style.getPropertyValue(`--semantic-transition-${token}-timing-function`).trim() || "ease-out",
	};
}

/** Fades `page` in or out with `semantic.transition.fade`, then calls `done`. */
function fade(stack: HTMLElement, page: HTMLElement | undefined, show: boolean, done?: () => void) {
	if (!page) {
		done?.();
		return;
	}
	const { duration, easing } = motion(stack, "fade");
	const from = getComputedStyle(page).opacity;
	const to = show ? "1" : "0";
	page.style.opacity = show ? "" : "0";
	if (!duration) {
		done?.();
		return;
	}
	const animation = page.animate([{ opacity: from }, { opacity: to }], { duration, easing });
	animation.onfinish = () => done?.();
	animation.oncancel = () => done?.();
}

/** The pages rendered in `stack`, bottom first (the current stack, then a popped page while it leaves). */
function pagesOf(stack: HTMLElement): HTMLElement[] {
	return Array.from(stack.children).filter(
		(element): element is HTMLElement => element instanceof HTMLElement && element.hasAttribute("data-drawer-page"),
	);
}

function frame(stack: HTMLElement, x: number, dim: number) {
	const sign = getComputedStyle(stack).direction === "rtl" ? -1 : 1;
	return {
		transform: x ? `translateX(${sign * x * 100}%)` : "none",
		filter: dim ? `brightness(${1 - dim})` : "none",
	};
}

/** Places a page without animation. */
function place(stack: HTMLElement, page: HTMLElement | undefined, x: number, dim = 0) {
	if (!page) return;
	const { transform, filter } = frame(stack, x, dim);
	page.style.transform = transform === "none" ? "" : transform;
	page.style.filter = filter === "none" ? "" : filter;
}

type Move = { page: HTMLElement | undefined; to: number; dim?: number };

/** Moves pages from where they are to their places, then calls `done`. */
function animate(stack: HTMLElement, moves: Move[], speed = 1, done?: () => void) {
	const { duration, easing } = motion(stack);
	const time = duration * speed;
	let pending = moves.length;
	const finish = () => {
		pending -= 1;
		if (pending === 0) done?.();
	};
	if (!pending) done?.();
	for (const { page, to, dim = 0 } of moves) {
		if (!page) {
			finish();
			continue;
		}
		const current = getComputedStyle(page);
		const from = { transform: current.transform, filter: current.filter };
		place(stack, page, to, dim);
		if (!time) {
			finish();
			continue;
		}
		const animation = page.animate([from, frame(stack, to, dim)], { duration: time, easing });
		animation.onfinish = finish;
		animation.oncancel = finish;
	}
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

type PageState = { depth: number; current: boolean; onBack: () => void; backLabel: string; closeLabel: string };
const PageContext = createContext<PageState | null>(null);

export interface DrawerStackProps extends Omit<DrawerContentProps, "children"> {
	/** Goes back a page: remove the last page. Called by the back button and by a swipe towards the inline end. */
	onBack: () => void;
	/** The back button's accessible name. Default "Back". */
	backLabel?: string | undefined;
	/** The close button's accessible name. Default "Close". */
	closeLabel?: string | undefined;
	/**
	 * How pages change. `slide`: a pushed page slides in from the inline end over the one below, which shifts aside
	 * and dims, and a swipe towards the inline end goes back. `fade`: pages crossfade, without movement or swipe back,
	 * such as in a panel docked beside a desktop layout. Default `slide`.
	 */
	transition?: "slide" | "fade" | undefined;
	/** `Drawer.Page` elements with keys, bottom first. The last one is shown. */
	children?: ReactNode;
}

/**
 * A stack of pages in a drawer, like a phone's navigation stack. Each page is a card with its own header and scroll
 * position. A pushed page slides in from the inline end over the one below, which shifts aside and dims; going back
 * (the back button, or a swipe towards the inline end) reverses it. With `transition="fade"` pages crossfade instead.
 * Put it directly in `Drawer.Popup`.
 */
function DrawerStack({
	onBack,
	backLabel = "Back",
	closeLabel = "Close",
	transition = "slide",
	children,
	className,
	ref,
	...props
}: DrawerStackProps) {
	const sheet = useContext(SheetContext);
	const popup = useContext(PopupContext);
	const pages = Children.toArray(children).filter(isValidElement);
	const keys = pages.map((page) => String(page.key));
	const keyList = keys.join("\n");
	// A popped page stays rendered until it has slid away.
	const [previous, setPrevious] = useState<{ children: ReactNode; pages: ReactElement[] }>({ children, pages });
	const [leaving, setLeaving] = useState<ReactElement | null>(null);
	/** Set when a swipe already moved the popped page off: no second animation. */
	const [swiped, setSwiped] = useState(false);
	if (children !== previous.children) {
		const before = previous.pages.map((page) => String(page.key));
		const popped = keys.length < before.length && keys.every((key, index) => key === before[index]);
		if (popped) {
			setLeaving(swiped ? null : (previous.pages.at(-1) ?? null));
			setSwiped(false);
		} else if (leaving && keys.includes(String(leaving.key))) setLeaving(null);
		setPrevious({ children, pages });
	}
	const [stack, setStack] = useState<HTMLDivElement | null>(null);
	const stackRef = useCallback(
		(element: HTMLDivElement | null) => {
			setStack(element);
			setRef(ref, element);
		},
		[ref],
	);
	// Opened deep: the pages below wait aside, as if pushed.
	useLayoutEffect(() => {
		if (!stack || transition !== "slide") return;
		for (const page of pagesOf(stack).slice(0, -1)) place(stack, page, -0.3, DIM);
	}, [stack, transition]);
	// Push: the new page comes in from the inline end over the one below. Pop: the top page leaves towards it.
	const committed = useRef(keys);
	useLayoutEffect(() => {
		const after = keyList ? keyList.split("\n") : [];
		const before = committed.current;
		committed.current = after;
		if (!stack) return;
		const rendered = pagesOf(stack);
		const extending = (longer: string[], shorter: string[]) => shorter.every((key, index) => key === longer[index]);
		let changed = false;
		const removeLeaving = () => setLeaving((page) => (page && !after.includes(String(page.key)) ? null : page));
		if (transition === "fade") {
			if (after.length > before.length && before.length && extending(after, before)) {
				const top = rendered[after.length - 1];
				if (top) top.style.opacity = "0";
				fade(stack, top, true);
				changed = true;
			} else if (after.length < before.length && extending(before, after)) {
				fade(stack, rendered[after.length], false, removeLeaving);
				changed = true;
			}
		} else if (after.length > before.length && before.length && extending(after, before)) {
			const top = rendered[after.length - 1];
			place(stack, top, 1);
			animate(stack, [
				{ page: top, to: 0 },
				{ page: rendered[after.length - 2], to: -0.3, dim: DIM },
			]);
			changed = true;
		} else if (after.length < before.length && extending(before, after)) {
			animate(
				stack,
				[
					{ page: rendered[after.length], to: 1 },
					{ page: rendered[after.length - 1], to: 0 },
				],
				1,
				removeLeaving,
			);
			changed = true;
		}
		// Focus follows to the page shown when it was in the stack (or lost to the page below going inert).
		const focused = document.activeElement;
		if (changed && (!focused || focused === document.body || focused === popup || stack.contains(focused)))
			rendered[after.length - 1]
				?.querySelector<HTMLElement>("[data-drawer-page-title]")
				?.focus({ preventScroll: true });
	}, [keyList, stack, popup, transition]);
	// Swipe back, listening on the popup. A bottom sheet's drag to close (sheet-drag.ts) leaves horizontal moves alone.
	const latest = useRef({ count: keys.length, onBack, swipe: transition === "slide" });
	useLayoutEffect(() => {
		latest.current = { count: keys.length, onBack, swipe: transition === "slide" };
	});
	useEffect(() => {
		if (!popup || !stack) return undefined;
		const pair = () => {
			const rendered = pagesOf(stack);
			const { count } = latest.current;
			return { below: rendered[count - 2], top: rendered[count - 1] };
		};
		return attachSwipeBack(popup, {
			stack,
			canGoBack: () => latest.current.swipe && latest.current.count > 1,
			swipe: (offset) => {
				const { below, top } = pair();
				const width = stack.clientWidth || 1;
				const progress = Math.max(0, offset) / width;
				place(stack, top, offset / width);
				place(stack, below, -0.3 * (1 - progress), DIM * (1 - progress));
			},
			swipeEnd: (back) => {
				const { below, top } = pair();
				if (back)
					animate(
						stack,
						[
							{ page: top, to: 1 },
							{ page: below, to: 0 },
						],
						SWIPE_FINISH,
						() => {
							setSwiped(true);
							latest.current.onBack();
						},
					);
				else
					animate(stack, [
						{ page: top, to: 0 },
						{ page: below, to: -0.3, dim: DIM },
					]);
			},
		});
	}, [popup, stack]);
	const rendered = leaving ? [...pages, leaving] : pages;
	return (
		<ElanorDrawer.Content
			{...props}
			ref={stackRef}
			{...(!sheet?.drag && transition === "slide" && pages.length > 1 ? { "data-base-ui-swipe-ignore": "" } : {})}
			className={mergeClassName("el-drawer-stack", className)}
		>
			{rendered.map((page, index) => (
				<PageContext
					key={String(page.key)}
					value={{ depth: index, current: index === pages.length - 1, onBack, backLabel, closeLabel }}
				>
					{page}
				</PageContext>
			))}
		</ElanorDrawer.Content>
	);
}

export interface DrawerPageProps extends Omit<ComponentPropsWithRef<"div">, "title"> {
	/** The page's title in its header, on one line. The first page's title is the drawer's `Drawer.Title`. */
	title: ReactNode;
	/**
	 * A value that changes when content arrives at the end of the page, such as a count. When it changes while the
	 * reader is at the end, the page scrolls to its new end.
	 */
	follow?: unknown;
	children?: ReactNode;
}

/**
 * One page of a `Drawer.Stack`: a card with a sticky header (a back button on deeper pages, the title, and a close
 * button on the first page) and its own scroll position. Extra props go on the card, the element that scrolls.
 */
function DrawerPage({ title, follow, children, className, ref, onScroll, ...props }: DrawerPageProps) {
	const context = useContext(PageContext);
	const depth = context?.depth ?? 0;
	const current = context?.current ?? true;
	const scroller = useRef<HTMLDivElement | null>(null);
	const pageRef = useCallback(
		(element: HTMLDivElement | null) => {
			scroller.current = element;
			setRef(ref, element);
		},
		[ref],
	);
	const atEnd = useRef(true);
	const followed = useRef(follow);
	useEffect(() => {
		const before = followed.current;
		followed.current = follow;
		const element = scroller.current;
		if (Object.is(before, follow) || !element || !atEnd.current) return;
		element.scrollTo({ top: element.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
	}, [follow]);
	const handleScroll = (event: UIEvent<HTMLDivElement>) => {
		const element = event.currentTarget;
		atEnd.current = element.scrollHeight - element.clientHeight - element.scrollTop < END;
		onScroll?.(event);
	};
	return (
		<div
			{...props}
			ref={pageRef}
			className={classes("el-drawer-page", className)}
			data-drawer-page=""
			data-current={current || undefined}
			aria-hidden={current ? undefined : true}
			inert={!current}
			onScroll={handleScroll}
		>
			<header className="el-drawer-page-header">
				{depth > 0 && (
					<IconButton
						className="el-drawer-page-back"
						aria-label={context?.backLabel ?? "Back"}
						onClick={context?.onBack}
					>
						<ChevronLeftIcon />
					</IconButton>
				)}
				{depth === 0 ? (
					<ElanorDrawer.Title className="el-drawer-page-title" tabIndex={-1} data-drawer-page-title="">
						{title}
					</ElanorDrawer.Title>
				) : (
					<h3 className="el-drawer-page-title" tabIndex={-1} data-drawer-page-title="">
						{title}
					</h3>
				)}
				{depth === 0 && (
					<ElanorDrawer.Close
						render={<IconButton className="el-drawer-page-close" aria-label={context?.closeLabel ?? "Close"} />}
					>
						<CloseIcon />
					</ElanorDrawer.Close>
				)}
			</header>
			<div className="el-drawer-page-body">{children}</div>
		</div>
	);
}

export const Drawer = {
	Root: DrawerRoot,
	Backdrop: DrawerBackdrop,
	Popup: DrawerPopup,
	Stack: DrawerStack,
	Page: DrawerPage,
	Portal: ElanorDrawer.Portal,
	Viewport: ElanorDrawer.Viewport,
	Title: ElanorDrawer.Title,
	Close: ElanorDrawer.Close,
};

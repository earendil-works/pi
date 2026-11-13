// Elanor's Ticker, built in p2 until Elanor's npm release has it (its 0.1.0 does not): ported from Elanor's source as
// vendored on the p2-elanor branch, with its styles in elanor-extra.css. Replace with `Ticker` from
// @earendil-works/elanor-react once it ships; the props are the same.
import {
	Children,
	createContext,
	type HTMLAttributes,
	isValidElement,
	type ReactElement,
	type ReactNode,
	type Ref,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { createDrum, FACE } from "./drum.ts";
import "./elanor-extra.css";

/** Degrees between neighbouring items on the drum, and the drum's radius (px). */
const STEP = 25;
const RADIUS = FACE / (2 * Math.sin(((STEP / 2) * Math.PI) / 180));
/** Items further than this from the one facing the reader are out of sight and not rendered. */
const VISIBLE = 3.5;
/** Each item of distance from the reader takes this much opacity. */
const FADE = 0.55;

const ItemContext = createContext({ distance: 0, current: true, newest: true, settled: false });

export interface TickerRootProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
	readonly ref?: Ref<HTMLElement> | undefined;
	/** Makes the newest item breathe while it faces the reader, to show that work is going on. */
	active?: boolean | undefined;
	/** Shows only the item facing the reader, without its neighbours, such as a finished summary. */
	settled?: boolean | undefined;
	/**
	 * Makes the ticker a button. A tap (not a drag) calls it with the key of the item the reader rolled to, or
	 * `undefined` on the newest item. Without it, the ticker still scrolls but is neither focusable nor clickable.
	 */
	onActivate?: ((key?: string) => void) | undefined;
	/**
	 * p2 addition (not Elanor's): called when another item turns to face the reader, rolled by the reader or by a new
	 * item rolling in; not when the ticker first shows. For a detent's haptic tick.
	 */
	onTurn?: (() => void) | undefined;
	/** `Ticker.Item` elements with keys, oldest first. The last is the newest. */
	children?: ReactNode;
}

export interface TickerItemProps {
	/** The item as plain text: the ticker's accessible name while it faces the reader, and its live announcement. */
	label: string;
	/** Colors the item and its icons negative, such as a failure. */
	negative?: boolean | undefined;
	/** What the item shows: usually an icon and a line of text, in a row. Text in an element ends in an ellipsis. */
	children?: ReactNode;
}

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * One line showing the newest of a sequence, such as the step an agent is on. Items sit on a drum like iOS's picker:
 * a new item rolls in, and the reader can drag it, turn it with the mouse wheel, or (as a button) use the arrow keys
 * to roll back through earlier ones. Screen readers hear each new item's label politely.
 */
function TickerRoot({
	ref,
	active = false,
	settled = false,
	onActivate,
	onTurn,
	className,
	children,
	...props
}: TickerRootProps) {
	const items: ReactElement<TickerItemProps>[] = [];
	// Children.forEach passes the elements as given, with their own keys.
	Children.forEach(children, (child) => {
		if (isValidElement<TickerItemProps>(child)) items.push(child);
	});
	const last = Math.max(0, items.length - 1);
	const [position, setPosition] = useState(last);
	const [drum] = useState(() => createDrum(last, setPosition));
	useEffect(() => drum.setLast(last), [drum, last]);
	useEffect(() => () => drum.destroy(), [drum]);
	// Native listeners: React's wheel events are passive and cannot keep the page still; the pointer ones live beside
	// it.
	const [element, setElement] = useState<HTMLElement | null>(null);
	const rootRef = useCallback(
		(node: HTMLElement | null) => {
			setElement(node);
			if (typeof ref === "function") ref(node);
			else if (ref) ref.current = node;
		},
		[ref],
	);
	useEffect(() => {
		if (!element) return undefined;
		const dragStart = (event: Event) => event.preventDefault();
		element.addEventListener("wheel", drum.wheel, { passive: false });
		element.addEventListener("pointerdown", drum.pointerDown);
		element.addEventListener("pointermove", drum.pointerMove);
		element.addEventListener("pointerup", drum.pointerUp);
		element.addEventListener("pointercancel", drum.pointerCancel);
		element.addEventListener("lostpointercapture", drum.lostCapture);
		// A native drag (of text or an image inside) would take the pointer without ending the drum's drag.
		element.addEventListener("dragstart", dragStart);
		// Switching away mid-drag (another window, an alert) ends the drag too.
		window.addEventListener("blur", drum.lostCapture);
		return () => {
			element.removeEventListener("wheel", drum.wheel);
			element.removeEventListener("pointerdown", drum.pointerDown);
			element.removeEventListener("pointermove", drum.pointerMove);
			element.removeEventListener("pointerup", drum.pointerUp);
			element.removeEventListener("pointercancel", drum.pointerCancel);
			element.removeEventListener("lostpointercapture", drum.lostCapture);
			element.removeEventListener("dragstart", dragStart);
			window.removeEventListener("blur", drum.lostCapture);
		};
	}, [element, drum]);
	const currentIndex = Math.min(last, Math.max(0, Math.round(position)));
	// Another item faces the reader: a detent (not on the first render).
	const faced = useRef(currentIndex);
	const turned = useRef(onTurn);
	turned.current = onTurn;
	useEffect(() => {
		if (faced.current === currentIndex) return;
		faced.current = currentIndex;
		turned.current?.();
	}, [currentIndex]);
	const keyOf = (item: ReactElement | undefined) => (item?.key == null ? undefined : item.key);
	const shared = {
		...props,
		className: classes("el-ticker", className),
		"data-active": active || undefined,
		"data-settled": settled || undefined,
	};
	const drawn = (
		<span className="el-ticker-drum">
			{items.map((item, index) => {
				const distance = index - position;
				if (Math.abs(distance) > VISIBLE) return null;
				return (
					<ItemContext
						key={keyOf(item) ?? index}
						value={{ distance, current: index === currentIndex, newest: index === items.length - 1, settled }}
					>
						{item}
					</ItemContext>
				);
			})}
		</span>
	);
	const label = items[currentIndex]?.props.label;
	const announcement = (
		<span className="el-ticker-announcement" aria-live="polite" aria-atomic="true">
			{items.at(-1)?.props.label}
		</span>
	);
	if (!onActivate)
		return (
			<>
				<span ref={rootRef} {...shared}>
					{drawn}
				</span>
				{announcement}
			</>
		);
	return (
		<>
			<button
				type="button"
				aria-label={label}
				ref={rootRef}
				{...shared}
				onClick={(event) => {
					// Its own taps are its own: the row around it may open the same thing.
					event.stopPropagation();
					props.onClick?.(event);
					if (drum.takeDragged()) return;
					const index = drum.index();
					onActivate(index === items.length - 1 ? undefined : keyOf(items[index]));
				}}
				onKeyDown={(event) => {
					props.onKeyDown?.(event);
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault();
						drum.step(event.key === "ArrowUp" ? -1 : 1);
					}
				}}
			>
				{drawn}
			</button>
			{announcement}
		</>
	);
}

/** One item of the sequence. Its React `key` is what `onActivate` receives. */
function TickerItem({ negative = false, children }: TickerItemProps) {
	const { distance, current, newest, settled } = useContext(ItemContext);
	const opacity = settled && !current ? 0 : Math.max(0, 1 - Math.abs(distance) * FADE);
	return (
		<span
			className="el-ticker-item"
			aria-hidden={current ? undefined : true}
			data-current={current || undefined}
			data-newest={newest || undefined}
			data-negative={negative || undefined}
			style={{
				transform: `translateZ(${-RADIUS}px) rotateX(${-distance * STEP}deg) translateZ(${RADIUS}px)`,
				opacity,
			}}
		>
			<span className="el-ticker-content">{children}</span>
		</span>
	);
}

export const Ticker = { Root: TickerRoot, Item: TickerItem };

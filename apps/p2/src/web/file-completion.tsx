// `@` and Tab file completion in the web composer (p2-tui-port.md section 8.4, P7c; a p2 addition, Pi Mobile has
// none). The same rules as the TUI (src/runtime/completion.ts): `@` after a token boundary opens a popover of the
// session's FileIndex matches; a Tab on a path-like token lists that directory. While the popover is open, Enter/Tab
// apply, arrows move and Escape closes, ahead of send and stop. Keys during IME composition are ignored and the popover
// never opens mid-composition. `@pi` (chat mode's agent mention) is never completed as a file; in chat mode a
// synthetic "@pi — mention Pi" item comes first.
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import {
	applyFileCompletion,
	atItems,
	type CompletionItem,
	extractAtPrefix,
	extractPathPrefix,
	isMentionToken,
	mentionItems,
	outOfScope,
	parsePathPrefix,
	pathCompletion,
	pathItems,
	shouldTriggerFileCompletion,
} from "../runtime/completion.ts";
import { FileIndex } from "../runtime/file-index.ts";
import { useObject, useStatus } from "../runtime/web.tsx";

const DEBOUNCE_MS = 80;
/** The FileIndex reference (it leases the workspace watch) outlives a blur this long. */
const RELEASE_MS = 30_000;

type Popover = { items: CompletionItem[]; prefix: string; selected: number; hint?: string };
export type FileCompletion = {
	popover: Popover | undefined;
	/** Handles the key when completion owns it (call first); true means "consumed". */
	onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
	/** After every edit or caret move. */
	update(): void;
	onFocus(): void;
	onBlur(): void;
	onCompositionStart(): void;
	onCompositionEnd(): void;
	choose(index: number): void;
};

export function useFileCompletion(
	textarea: RefObject<HTMLTextAreaElement | null>,
	setDraft: (text: string) => void,
	scope: { session: string; conversation: number } | undefined,
	/** `mention`: the agent's name while chat mode is on, offered first as `@name`. */
	options: { mention: string | undefined },
): FileCompletion {
	const [focused, setFocused] = useState(false);
	const [held, setHeld] = useState(false);
	useEffect(() => {
		if (focused) {
			setHeld(true);
			return;
		}
		const timer = setTimeout(() => setHeld(false), RELEASE_MS);
		return () => clearTimeout(timer);
	}, [focused]);
	const index = useObject(FileIndex, scope && held ? scope : undefined);
	const [popover, setPopover] = useState<Popover>();
	const composing = useRef(false);
	const request = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	// Re-renders when the index becomes live (or goes), so the arrival below can ask again.
	const status = useStatus(index);
	const live = status === "live" && index?.variant === "reader" ? index : undefined;

	const close = () => {
		request.current++;
		clearTimeout(timer.current);
		setPopover(undefined);
	};

	/** Queries for the token before the caret; `force` is a Tab (directory listing). */
	const query = (force: boolean): boolean => {
		const element = textarea.current;
		if (!element || composing.current) return false;
		const before = element.value.slice(0, element.selectionStart ?? element.value.length);
		const at = extractAtPrefix(before);
		const id = ++request.current;
		clearTimeout(timer.current);
		if (at !== null) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(at);
			if (isMentionToken(at, options.mention)) {
				setPopover(undefined);
				return false;
			}
			const mention: CompletionItem[] = mentionItems(rawPrefix, options.mention);
			if (outOfScope(rawPrefix)) {
				setPopover({ items: mention, prefix: at, selected: 0, hint: "Completion covers the session directory" });
				return true;
			}
			timer.current = setTimeout(() => {
				if (!live) {
					setPopover(mention.length ? { items: mention, prefix: at, selected: 0 } : undefined);
					return;
				}
				void live
					.complete({ query: rawPrefix, limit: 20 }, BACKGROUND_CONTEXT)
					.then((result) => {
						if (id !== request.current) return;
						const items = [...mention, ...atItems(result.items, { isQuotedPrefix })];
						setPopover(
							items.length || result.truncated
								? {
										items,
										prefix: at,
										selected: 0,
										...(result.truncated ? { hint: "Partial index: the directory is very large" } : {}),
									}
								: undefined,
						);
					})
					.catch(() => id === request.current && setPopover(undefined));
			}, DEBOUNCE_MS);
			return true;
		}
		if (!force) {
			setPopover(undefined);
			return false;
		}
		// A forced Tab only on a path-like token, so Tab still moves focus elsewhere.
		if (!shouldTriggerFileCompletion(before) || extractPathPrefix(before) === null) return false;
		const prefix = extractPathPrefix(before, true) ?? "";
		const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
		if (outOfScope(rawPrefix)) {
			setPopover({ items: [], prefix, selected: 0, hint: "Completion covers the session directory" });
			return true;
		}
		if (!live) return false;
		void live
			.list({ path: pathCompletion(rawPrefix).dir }, BACKGROUND_CONTEXT)
			.then((listed) => {
				if (id !== request.current) return;
				const items = pathItems(listed.entries, rawPrefix, { isAtPrefix, isQuotedPrefix });
				// pi: a single match is applied at once.
				if (items.length === 1) apply(items[0]!, prefix);
				else setPopover(items.length ? { items, prefix, selected: 0 } : undefined);
			})
			.catch(() => {});
		return true;
	};

	const apply = (item: CompletionItem, prefix: string): void => {
		const element = textarea.current;
		if (!element) return;
		const cursor = element.selectionStart ?? element.value.length;
		const lineStart = element.value.lastIndexOf("\n", cursor - 1) + 1;
		const lineEnd = element.value.indexOf("\n", cursor);
		const end = lineEnd === -1 ? element.value.length : lineEnd;
		const result = applyFileCompletion(element.value.slice(lineStart, end), cursor - lineStart, item, prefix);
		const text = element.value.slice(0, lineStart) + result.line + element.value.slice(end);
		setDraft(text);
		setPopover(undefined);
		const caret = lineStart + result.cursorCol;
		requestAnimationFrame(() => {
			element.setSelectionRange(caret, caret);
			// A directory continues: list what is inside.
			if (item.label.endsWith("/")) query(false);
		});
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (event.nativeEvent.isComposing || composing.current) return false;
		if (popover) {
			const count = popover.items.length;
			if (event.key === "ArrowDown" && count) {
				event.preventDefault();
				setPopover({ ...popover, selected: (popover.selected + 1) % count });
				return true;
			}
			if (event.key === "ArrowUp" && count) {
				event.preventDefault();
				setPopover({ ...popover, selected: (popover.selected - 1 + count) % count });
				return true;
			}
			if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && count) {
				event.preventDefault();
				apply(popover.items[popover.selected]!, popover.prefix);
				return true;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				return true;
			}
		}
		if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
			if (query(true)) {
				event.preventDefault();
				return true;
			}
		}
		return false;
	};

	// The index arrives after the first keystrokes (it is held from focus): ask again for the token typed meanwhile.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the index's arrival triggers this.
	useEffect(() => {
		if (live && focused) query(false);
	}, [live]);

	return {
		popover,
		onKeyDown,
		update: () => {
			if (!composing.current) query(false);
		},
		onFocus: () => setFocused(true),
		onBlur: () => {
			setFocused(false);
			close();
		},
		onCompositionStart: () => {
			composing.current = true;
			close();
		},
		onCompositionEnd: () => {
			composing.current = false;
		},
		choose: (selected) => {
			const item = popover?.items[selected];
			if (item && popover) apply(item, popover.prefix);
		},
	};
}

/** The popover above the textarea; pointer selection works too (mousedown keeps the textarea focused). */
export function FileCompletionPopover({ completion }: { completion: FileCompletion }) {
	const popover = completion.popover;
	if (!popover) return null;
	return (
		<div className="file-completion" role="listbox" aria-label="File completion">
			{popover.items.map((item, index) => (
				<div
					key={`${item.value}-${index}`}
					role="option"
					tabIndex={-1}
					aria-selected={index === popover.selected}
					className={index === popover.selected ? "selected" : undefined}
					onMouseDown={(event) => {
						event.preventDefault();
						completion.choose(index);
					}}
				>
					<span className="file-completion-label">{item.label}</span>
					{item.description && <span className="file-completion-path">{item.description}</span>}
				</div>
			))}
			{popover.hint && <div className="file-completion-hint">{popover.hint}</div>}
		</div>
	);
}

// Instruments a page for transcript stability checks (ui-transcript-stability.test.ts), installed before the page loads
// (`Page.addScriptToEvaluateOnNewDocument`):
//
// - Renders per transcript row: a stand-in for React's DevTools hook sees every commit; a function component rendered
//   in a commit when its fiber has React's PerformedWork flag and is not the fiber that was current after the previous
//   commit (a subtree React skipped keeps its old fibers, flags included). Each commit counts once per row (`data-row`)
//   whose subtree rendered anything.
// - DOM churn per row: a MutationObserver counts the nodes added and removed inside each row, and the row elements a
//   check sees again prove their nodes were kept.
// - Layout shifts: Chromium's `layout-shift` entries (without recent input), with the elements that moved.

/** The page script. */
export const RENDER_PROBE = `(() => {
	const probe = { commits: 0, renders: new Map(), churn: new Map(), shifts: [], left: new Set() };
	window.__probe = probe;
	let previous = new WeakSet();
	const COMPONENT = new Set([0, 1, 11, 14, 15]);
	const visit = (root) => {
		const current = new WeakSet();
		const rendered = new Set();
		const stack = [[root, undefined]];
		while (stack.length) {
			const [fiber, row] = stack.pop();
			current.add(fiber);
			const props = fiber.memoizedProps;
			const key = fiber.tag === 5 && props && typeof props["data-row"] === "string" ? props["data-row"] : row;
			if (key !== undefined && COMPONENT.has(fiber.tag) && (fiber.flags & 1) && !previous.has(fiber)) rendered.add(key);
			if (fiber.sibling) stack.push([fiber.sibling, row]);
			if (fiber.child) stack.push([fiber.child, key]);
		}
		previous = current;
		for (const key of rendered) probe.renders.set(key, (probe.renders.get(key) ?? 0) + 1);
	};
	window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
		renderers: new Map(),
		supportsFiber: true,
		inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
		onScheduleFiberRoot() {},
		onCommitFiberRoot(_id, root) { probe.commits++; if (root.current.child) visit(root.current.child); },
		onCommitFiberUnmount() {},
		onPostCommitFiberRoot() {},
		checkDCE() {},
	};
	const rowOf = (node) => (node instanceof Element ? node : node.parentElement)?.closest("[data-row]")?.getAttribute("data-row");
	new MutationObserver((records) => {
		for (const record of records) {
			// Rows the virtual list unmounts (scrolled out of its range) come back as new elements: not churn.
			for (const node of record.removedNodes)
				if (node instanceof Element && node.hasAttribute("data-row")) probe.left.add(node.getAttribute("data-row"));
			const key = rowOf(record.target);
			if (key === undefined || record.target.matches?.("[data-row]") && record.type === "attributes") continue;
			const count = record.type === "childList" ? record.addedNodes.length + record.removedNodes.length : 1;
			probe.churn.set(key, (probe.churn.get(key) ?? 0) + count);
		}
	}).observe(document, { subtree: true, childList: true, characterData: true });
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (entry.hadRecentInput) continue;
			probe.shifts.push({
				value: entry.value,
				at: Math.round(entry.startTime),
				sources: entry.sources.map((source) => {
					const node = source.node;
					const element = node instanceof Element ? node : node?.parentElement;
					const row = element?.closest("[data-row]");
					return {
						what: element ? element.tagName.toLowerCase() + (element.className && typeof element.className === "string" ? "." + element.className.split(" ").filter(Boolean).join(".") : "") : "?",
						row: row?.getAttribute("data-row"),
						from: [Math.round(source.previousRect.y), Math.round(source.previousRect.height)],
						to: [Math.round(source.currentRect.y), Math.round(source.currentRect.height)],
					};
				}),
			});
		}
	}).observe({ type: "layout-shift", buffered: true });
	/**
	 * Follows, every frame, where the row \`key\` is (its top in the viewport) and how tall the transcript is: a row of a
	 * reader following the bottom only ever moves up as content arrives below it, so every move down is a jump.
	 */
	probe.watch = (key) => {
		probe.track = { key, downs: 0, moves: [], shrinks: 0, frames: 0 };
		let top;
		let height;
		const frame = () => {
			const track = probe.track;
			if (!track || track.key !== key) return;
			const row = document.querySelector('[data-row="' + CSS.escape(key) + '"]');
			const scroller = document.querySelector('.scroller.transcript');
			if (row && scroller) {
				track.frames++;
				const now = row.getBoundingClientRect().top;
				if (top !== undefined && now > top + 0.5) {
					track.downs += now - top;
					track.moves.push([Math.round(performance.now()), Math.round(now - top)]);
				}
				top = now;
				// The laid-out height: a glide (use-chat-scroll.ts) draws the transcript lower for a moment, which the
				// browser counts in scrollHeight.
				const laid = document.querySelector('.messages').offsetHeight;
				if (height !== undefined && laid < height - 0.5) track.shrinks++;
				height = laid;
			}
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
		return true;
	};
	/** Starts a measurement: counts from zero, and remembers the rows' elements to compare later. */
	probe.reset = () => {
		probe.track = undefined;
		probe.commits = 0;
		probe.renders.clear();
		probe.churn.clear();
		probe.shifts = [];
		probe.left.clear();
		probe.elements = new Map([...document.querySelectorAll("[data-row]")].map((element) => [element.getAttribute("data-row"), element]));
	};
	/** What happened since \`reset\`, and which of the rows then shown still have the same element. */
	probe.report = () => {
		const kept = [];
		const replaced = [];
		for (const [key, element] of probe.elements ?? []) {
			const now = document.querySelector('[data-row="' + CSS.escape(key) + '"]');
			if (!now) continue;
			(now === element ? kept : replaced).push(key);
		}
		return {
			commits: probe.commits,
			renders: Object.fromEntries(probe.renders),
			churn: Object.fromEntries(probe.churn),
			shift: probe.shifts.reduce((sum, shift) => sum + shift.value, 0),
			shifts: probe.shifts,
			kept,
			replaced,
			track: probe.track,
			left: [...probe.left],
			rows: [...document.querySelectorAll("[data-row]")].map((element) => element.getAttribute("data-row")),
		};
	};
})();`;

export type ProbeReport = {
	commits: number;
	renders: Record<string, number>;
	churn: Record<string, number>;
	shift: number;
	shifts: {
		value: number;
		at: number;
		sources: { what: string; row?: string; from: [number, number]; to: [number, number] }[];
	}[];
	kept: string[];
	replaced: string[];
	/** Rows the virtual list unmounted meanwhile (out of its range): mounted again, they are new elements. */
	left: string[];
	/** A watched row's moves down while the reader follows the bottom (px, and when), and the transcript shrinking. */
	track?: { key: string; downs: number; moves: [number, number][]; shrinks: number; frames: number };
	rows: string[];
};

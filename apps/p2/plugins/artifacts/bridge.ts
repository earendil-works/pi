// The bridge between an html artifact's sandboxed frame and the page (data only: the server injects the script, the
// web facet speaks its messages). The frame has an opaque origin and no app identity: everything it posts is untrusted,
// and all it gets is its own artifact's state. Custom views' pages run unchanged: `window.p2view` is theirs, the state
// is the artifact's.

/** The `channel` field of every bridge message, both ways. */
export const VIEW_CHANNEL = "p2-view";

/**
 * The script injected at the top of an html artifact's page: `window.p2view`, the page's side of the bridge.
 *
 * - `p2view.onState(fn)`: calls `fn(state, from)` with the artifact's state now (`from`: "init") and at each change
 *   made elsewhere (`from`: "update": the agent or another device); returns an unsubscribe function.
 * - `p2view.state`: the state last received (undefined before the first).
 * - `p2view.setState(next)`: saves the state (a JSON value, or a function of the current one); saved after a short
 *   pause, so call it freely while the person edits.
 * - `p2view.select(summary, data)`, `p2view.clearSelection()`: the person's selection in the view showing the page;
 *   `summary` is what the agent reads with their next message, `data` what `view_list` shows.
 * - `p2view.readOnly`: true for people who may only view the session (their changes are not saved).
 * - `p2view.onDescribeRegion(fn)`: `fn({ x, y, width, height })` returns what lies in that rectangle (CSS pixels of the
 *   frame) as text, for drawings the person makes over the view; by default the texts and labels of the elements there.
 *
 * The page's console lines (`log`, `info`, `debug`; errors and warnings come with the diagnostics) go to the page, and
 * the agent's code (`artifact_html_eval`) runs here as an async function body; its returned value comes back as JSON.
 */
export const VIEW_BRIDGE_SCRIPT = `(() => {
	const channel = ${JSON.stringify(VIEW_CHANNEL)};
	const post = (message) => { try { parent.postMessage({ channel, ...message }, "*"); } catch {} };
	const text = (args) => args.map((value) => { try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); } }).join(" ").slice(0, 4000);
	for (const level of ["log", "info", "debug"]) {
		const original = console[level];
		console[level] = (...args) => { post({ type: "log", level, text: text(args) }); original.apply(console, args); };
	}
	const AsyncFunction = (async () => {}).constructor;
	const run = async (id, code) => {
		try {
			const value = await new AsyncFunction(code)();
			let json = null;
			try { json = value === undefined ? null : JSON.parse(JSON.stringify(value)); } catch { json = String(value); }
			post({ type: "eval-result", id, ok: true, value: json });
		} catch (error) {
			post({ type: "eval-result", id, ok: false, error: String((error && error.stack) || error).slice(0, 4000) });
		}
	};
	const listeners = new Set();
	let state, received = false, readOnly = true, describe;
	const notify = (from) => { for (const fn of [...listeners]) { try { fn(state, from); } catch (error) { console.error(error); } } };
	window.p2view = {
		get state() { return state; },
		get readOnly() { return readOnly; },
		onState(fn) { listeners.add(fn); if (received) { try { fn(state, "init"); } catch (error) { console.error(error); } } return () => listeners.delete(fn); },
		setState(next) {
			state = typeof next === "function" ? next(state) : next;
			post({ type: "set-state", state: JSON.parse(JSON.stringify(state ?? null)) });
		},
		select(summary, data) { post({ type: "select", summary: String(summary ?? "").slice(0, 2000), data: data === undefined ? null : JSON.parse(JSON.stringify(data)) }); },
		clearSelection() { post({ type: "select", summary: "", data: null }); },
		onDescribeRegion(fn) { describe = fn; },
	};
	// An element's label, else its nearest labelled ancestor's, else its text, else its ID.
	const labelOf = (element) => {
		for (let at = element; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
			const label = at.getAttribute && (at.getAttribute("aria-label") || at.getAttribute("data-label") || at.getAttribute("title"));
			if (label) return label;
		}
		const text = (element.textContent || "").replace(/\\s+/g, " ").trim();
		if (text) return text.slice(0, 120);
		return element.id ? "#" + element.id : "";
	};
	const region = (rect) => {
		if (describe) return String(describe(rect) ?? "");
		const found = [];
		for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
			const element = document.elementFromPoint(rect.x + (rect.width * i) / 12, rect.y + (rect.height * j) / 12);
			if (element && element !== document.documentElement && element !== document.body && !found.includes(element)) found.push(element);
		}
		const labels = [];
		for (const element of found.filter((each) => !found.some((other) => other !== each && each.contains(other)))) {
			const label = labelOf(element);
			if (label && !labels.includes(label)) labels.push(label);
		}
		return labels.join(" · ").slice(0, 4000);
	};
	const highlight = (quotes) => {
		if (!window.CSS || !CSS.highlights || typeof Highlight !== "function") return;
		if (!document.getElementById("p2-view-highlights")) {
			const style = document.createElement("style");
			style.id = "p2-view-highlights";
			style.textContent = "::highlight(p2-note){background:rgba(255,196,0,.35)}::highlight(p2-note-delete){background:rgba(255,80,80,.25);text-decoration:line-through}";
			(document.head || document.documentElement).append(style);
		}
		const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
		const nodes = [];
		let text = "";
		for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push([node, text.length]); text += node.data; }
		const at = (offset) => { let low = 0; for (let i = 0; i < nodes.length && nodes[i][1] <= offset; i++) low = i; const [node, start] = nodes[low] || []; return node ? [node, Math.min(offset - start, node.data.length)] : undefined; };
		const notes = new Highlight(), deletes = new Highlight();
		for (const quote of quotes) {
			const index = quote.text ? text.indexOf(quote.text) : -1;
			if (index < 0) continue;
			const start = at(index), end = at(index + quote.text.length);
			if (!start || !end) continue;
			const range = document.createRange();
			try { range.setStart(start[0], start[1]); range.setEnd(end[0], end[1]); } catch { continue; }
			(quote.kind === "delete" ? deletes : notes).add(range);
		}
		CSS.highlights.set("p2-note", notes);
		CSS.highlights.set("p2-note-delete", deletes);
	};
	let selectionTimer;
	document.addEventListener("selectionchange", () => {
		clearTimeout(selectionTimer);
		selectionTimer = setTimeout(() => post({ type: "text-selection", text: String(getSelection() || "").slice(0, 4000) }), 150);
	});
	addEventListener("message", (event) => {
		if (event.source !== parent) return;
		const message = event.data;
		if (!message || typeof message !== "object" || message.channel !== channel) return;
		if (message.type === "state") {
			readOnly = message.readOnly === true;
			state = message.state;
			const from = received ? message.from : "init";
			received = true;
			notify(from);
		} else if (message.type === "describe") {
			let text = "";
			try { text = region(message.rect); } catch (error) { console.error(error); }
			post({ type: "region", id: message.id, text: String(text).slice(0, 4000) });
		} else if (message.type === "highlight") {
			try { highlight(Array.isArray(message.quotes) ? message.quotes : []); } catch {}
		} else if (message.type === "eval" && typeof message.code === "string") {
			void run(message.id, message.code);
		}
	});
	post({ type: "hello" });
})();`;

// The lists plugin on the page: a panel with a list's todos (live), a box to add one, a click to tick one off, and for
// the owner "Clear done". The list is the page's `#hash`, `groceries` without one. The half-typed todo is page state:
// a reload of this plugin remounts the panel, and the page keeps what was typed.

import { BACKGROUND_CONTEXT as context, defineFacet } from "@todo/app/v1";
import { Panels, useHold, usePageState, useWatch } from "@todo/app/v1/web";
import { createElement as h } from "react";
import { Todos } from "./contract.ts";
import "./lists.css";

function TodoList() {
	const list = location.hash.slice(1) || "groceries";
	const todos = useHold(Todos, { list });
	const items = useWatch(todos?.items) ?? [];
	// Kept by the page, not the component: the new code's component finds the half-typed todo.
	const [text, setText] = usePageState(`lists.draft.${list}`, "");
	const add = (event: { preventDefault(): void }) => {
		event.preventDefault();
		if (todos === undefined || text.trim() === "") return;
		void todos.add(text, context);
		setText("");
	};
	return h(
		"div",
		{ className: "lists-panel" },
		h(
			"ul",
			null,
			...items.map((item) =>
				h(
					"li",
					{
						key: item.id,
						className: item.done ? "lists-done" : undefined,
						onClick: () => void todos?.tick({ id: item.id, done: !item.done }, context),
					},
					item.text,
					h("span", { className: "lists-by" }, item.by),
				),
			),
		),
		h(
			"form",
			{ onSubmit: add },
			h("input", {
				value: text,
				placeholder: "Add a todo",
				onChange: (event: { target: { value: string } }) => setText(event.target.value),
			}),
		),
		todos?.variant === "owner"
			? h("button", { type: "button", onClick: () => void todos.clear(context) }, "Clear done")
			: null,
	);
}

export default defineFacet((_host, self) => self.contribute(Panels, { title: "Groceries", Component: TodoList }));

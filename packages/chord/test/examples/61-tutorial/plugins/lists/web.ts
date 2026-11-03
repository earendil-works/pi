// The lists plugin on the page: a panel with a list's todos (live), a box to add one, a click to tick one off, and for
// the owner "Clear done". The list is the page's `#hash`, `groceries` without one.

import { BACKGROUND_CONTEXT as context, defineFacet, Todos } from "@todo/app/v1";
import { Panels, useHold, useWatch } from "@todo/app/v1/web";
import { createElement as h, useState } from "react";
import "./lists.css";

function TodoList() {
	const todos = useHold(Todos, { list: location.hash.slice(1) || "groceries" });
	const items = useWatch(todos?.items) ?? [];
	const [text, setText] = useState("");
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

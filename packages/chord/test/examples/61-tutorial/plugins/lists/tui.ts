// The lists plugin in the terminal: the groceries list's todos, live; done ones muted.

import { defineFacet, Todos } from "@todo/app/v1";
import { Screens } from "@todo/app/v1/tui";

export default defineFacet((_host, self) =>
	self.contribute(Screens, {
		title: "Groceries",
		open: (scope, theme) => {
			const items = scope.watch(scope.hold(Todos, { list: "groceries" }).items);
			return () =>
				(items() ?? []).map((item) =>
					item.done ? theme.fg("muted", `[x] ${item.text}`) : `[ ] ${item.text} ${theme.fg("muted", item.by)}`,
				);
		},
	}),
);

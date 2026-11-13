// The lists plugin in the terminal: its title, the groceries list's todos, live, done ones muted, and the list's
// notice. Its texts are in the terminal's language (`scope.messages`), and its catalogs are contributed here: the
// plugin's own languages are its contributions to the terminal's `Translations`.

import { defineFacet, Translations } from "@todo/app/v1";
import { Screens } from "@todo/app/v1/tui";
import { Todos } from "./contract.ts";
import { messages } from "./messages.ts";

export default defineFacet((_host, self) => {
	self.contribute(Translations, messages.translations);
	self.contribute(Screens, {
		name: "groceries",
		open: (scope, theme) => {
			const t = scope.messages(messages);
			const todos = scope.hold(Todos, { list: "groceries" });
			const items = scope.watch(todos.items);
			const notice = scope.watch(todos.notice);
			return () => {
				const shown = notice();
				return [
					theme.fg("accent", t("title")),
					...(items() ?? []).map((item) =>
						item.done ? theme.fg("muted", `[x] ${item.text}`) : `[ ] ${item.text} ${theme.fg("muted", item.by)}`,
					),
					...(shown === undefined || shown === null ? [] : [theme.fg("warning", t.render(shown))]),
				];
			};
		},
	});
});

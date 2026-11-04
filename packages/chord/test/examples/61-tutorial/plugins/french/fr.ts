// French for the lists plugin, written once and contributed from each facet that renders (registries are per host). The
// lists plugin's keys and signatures come from its messages' type, an import erased at build.

import type { MessagesOf, Translation } from "@todo/app/v1";
import type { messages } from "../lists/messages.ts";

const lists: MessagesOf<typeof messages> = {
	title: "Courses",
	placeholder: "Nouvelle tâche",
	clearDone: "Retirer les tâches faites",
	open: (n) => `${n} à faire`,
	cleared: (by) => `${by} a retiré les tâches faites`,
};

export const french: readonly Translation[] = [{ namespace: "todo.lists", locale: "fr", messages: lists }];

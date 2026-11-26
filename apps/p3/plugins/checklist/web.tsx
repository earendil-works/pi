// The checklist plugin's web facet, contributions only: the checklist kind's view (`ThingViews`, `checklist-view.tsx`)
// and the plugin's catalogs (`Translations`). Who may do what is the things plugin's grants, edited in its Settings
// view; a checklist has no settings.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { CheckIcon, ThingViews } from "@earendil-works/p3/v1/web";
import { ChecklistView } from "./checklist-view.tsx";
import { ChecklistKind } from "./kind.ts";
import { messages } from "./messages.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingViews, { kind: ChecklistKind.name, Icon: CheckIcon, View: ChecklistView });
	self.contribute(Translations, messages.translations);
});

// The prompt plugin's texts people see (decision 65): the titles and tick labels of its two kinds, as the things
// plugin's Settings view shows them, and the refusals a person can cause by configuring a set of skills.

import { defineMessages } from "@earendil-works/p3/v1";

/** The prompt plugin's messages, by key. */
export const messages = defineMessages("prompt", {
	en: {
		kindInstructions: "Instructions",
		kindSkills: "Skills",
		instructionsTickUse: "Follow these instructions",
		skillsTickUse: "Use these skills",
		outsideRoot: (folder: string) => `The folder ${folder} is not inside the Pi's skills folder.`,
	},
});

// One set of skills on the server (`SkillSet`, one object per set, whoever holds it): its folder (the setting; none
// set: no skills and no watcher), the skills in it, read again whenever anything under the folder changes (also once a
// folder that did not exist is made), so every holder sees a new skill without a reload, and `read`, one skill's text.
// One watcher per set, not one per holder; it closes with the set's last holder.

import { arr, type FacetHost, invalid, local, method, obj, type P3Principal, str } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { FolderWatch, folderPath, readSkill, readSkills, skillsRoot } from "./folder.ts";
import { Skill, SkillText } from "./skills-kind.ts";
import { PromptStore } from "./store.ts";

/** Set `thing`: its folder (the setting), its skills, and `read`, the text and files of one of them. */
export const SkillSet = local("prompt.skill-set", {
	version: 1,
	params: { thing: str() },
	members: { folder: str(), skills: arr(Skill), read: method(obj({ name: str() }), SkillText) },
});

/** Serves `SkillSet` on `host`. */
export function serveSet(host: FacetHost<P3Principal>): void {
	host.serve(SkillSet, ({ thing }, self) => {
		const root = skillsRoot(self.registry(ServerRuntime).value.dataDir);
		const found = self.liveQuery(self.get(PromptStore, {}).skills.of, { thing }, { first: 1 });
		const folder = self.derive([found], ([{ rows }]) => rows[0]?.folder ?? "");
		// A stored folder was checked when it was configured; the root moves only with the data directory.
		const path = self.derive([folder], ([value]) => (value === "" ? null : folderPath(root, value)));
		const skills = self.writable<Skill[]>([]);
		const changes = self.writable(0);
		const watcher = self.open(
			async () => new FolderWatch(root, () => changes.set(changes.value + 1)),
			(watching) => watching.close(),
		);
		self.on(path, ({ value }) => watcher.value.watch(value ?? undefined));
		// One routine reads the folder: first, after a change of the folder, after each change in it (changes during a
		// read fold into one next read).
		const due = self.derive([path, changes], ([at, count]) => ({ at, count }));
		self.on(due, async ({ value }) => {
			const read = value.at === null ? [] : await readSkills(root, value.at);
			// A change of another file leaves the list as it was: no new value for every holder.
			if (!sameSkills(read, skills.value)) skills.set(read);
		});
		return {
			folder,
			skills: self.derive([skills], ([value]) => value),
			read: async ({ name }) => {
				const at = path.value;
				if (at === null) throw invalid("args", `prompt: no skill ${JSON.stringify(name)} (the set has no folder)`);
				return readSkill(root, at, name);
			},
		};
	});
}

/** Whether two lists of skills are the same, field by field. */
function sameSkills(a: readonly Skill[], b: readonly Skill[]): boolean {
	return (
		a.length === b.length &&
		a.every((skill, at) => skill.name === b[at]?.name && skill.description === b[at]?.description)
	);
}

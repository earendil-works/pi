// One set of skills on the server (`SkillSet`, one object per set, whoever holds it): its folder (the setting; none
// set: no skills and no watcher), the skills in it, read again whenever anything under the folder changes (also once a
// folder that did not exist is made), so every holder sees a new skill without a reload, and `read`, the text of one
// listed skill, from its folder. One watcher per set, not one per holder; it closes with the set's last holder.

import { mkdir } from "node:fs/promises";
import { arr, type FacetHost, invalid, local, method, obj, type P3Principal, str } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { folderPath, readSkill, readSkills, skillsRoot } from "./folder.ts";
import { Skill, SkillText } from "./skills-kind.ts";
import { PromptStore } from "./store.ts";
import { FolderWatch } from "./watch.ts";

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
			async () => {
				// The root exists before anything watches under it: a set's folder made later is seen there.
				await mkdir(root, { recursive: true });
				return new FolderWatch(root, () => changes.set(changes.value + 1));
			},
			(watching) => watching.close(),
		);
		self.on(path, ({ value }) => watcher.value.watch(value ?? undefined));
		// One routine reads the folder: first, after a change of the folder, after each change in it (changes during a
		// read fold into one next read).
		const due = self.derive([path, changes], ([at, count]) => ({ at, count }));
		// Where the listed skills were read and each one's folder (a name may be another than its folder's): `read`
		// opens what the list shows, never a folder of a path read since.
		let listed: { readonly at: string | null; readonly folders: ReadonlyMap<string, string> } = {
			at: null,
			folders: new Map(),
		};
		self.on(due, async ({ value }) => {
			const read = value.at === null ? [] : await readSkills(root, value.at);
			listed = { at: value.at, folders: new Map(read.map(({ skill, folder }) => [skill.name, folder])) };
			const list = read.map(({ skill }) => skill);
			// A change of another file leaves the list as it was: no new value for every holder.
			if (!sameSkills(list, skills.value)) skills.set(list);
		});
		return {
			folder,
			skills: self.derive([skills], ([value]) => value),
			read: async ({ name }) => {
				const { at, folders } = listed;
				const folder = folders.get(name);
				if (at === null || folder === undefined)
					throw invalid("args", `prompt: no skill ${JSON.stringify(name)} in this set`);
				return readSkill(root, at, folder, name);
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

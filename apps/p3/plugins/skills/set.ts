// One set of skills on the server (`SkillSet`, one object per set, whoever holds it): its folder (the setting; none
// set: the skills root itself) and the skills in it, read again whenever anything under the folder changes, so every
// holder sees a new skill without a reload. One watcher per set, not one per holder.

import { arr, type FacetHost, local, type P3Principal, str } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { Skill } from "./contract.ts";
import { FolderWatch, folderPath, readSkills, skillsRoot } from "./folder.ts";
import { SkillsStore } from "./store.ts";

/** Set `thing`: its folder's path on the Pi's disk and its skills. */
export const SkillSet = local("skills.set", {
	version: 1,
	params: { thing: str() },
	members: { path: str(), skills: arr(Skill) },
});

/** Serves `SkillSet` on `host`. */
export function serveSet(host: FacetHost<P3Principal>): void {
	host.serve(SkillSet, ({ thing }, self) => {
		const root = skillsRoot(self.registry(ServerRuntime).value.dataDir);
		const found = self.liveQuery(self.get(SkillsStore, {}).settings.of, { thing }, { first: 1 });
		// A stored folder was checked by `configure`; the root moves only with the data directory.
		const path = self.derive([found], ([{ rows }]) => folderPath(root, rows[0]?.folder ?? ""));
		const skills = self.writable<Skill[]>([]);
		const changes = self.writable(0);
		const watcher = self.open(
			async () => new FolderWatch(() => changes.set(changes.value + 1)),
			(watching) => watching.close(),
		);
		self.on(path, ({ value }) => watcher.value.watch(value));
		// One routine reads the folder: first, after a change of the folder, after each change in it (changes during a
		// read fold into one next read).
		const due = self.derive([path, changes], ([at, count]) => ({ at, count }));
		self.on(due, async ({ value }) => {
			skills.set(await readSkills(root, value.at));
		});
		// A writable is the object's own; holders get a derived view of it.
		return { path, skills: self.derive([skills], ([value]) => [...value]) };
	});
}

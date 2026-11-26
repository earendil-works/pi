// One set of skills on the server (`SkillSet`, one object per set, whoever holds it): its folder (the setting; none
// set: the skills root itself) and the skills in it, read again whenever anything under the folder changes, so every
// holder sees a new skill without a reload. One watcher per set, not one per holder.

import { join } from "node:path";
import { arr, type FacetHost, local, type P3Principal, str } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { Skill } from "./contract.ts";
import { FolderWatch, folderPath, readSkills } from "./folder.ts";
import { SkillsStore } from "./store.ts";

/** Set `thing`: its folder's path on the Pi's disk and its skills. */
export const SkillSet = local("skills.set", {
	version: 1,
	params: { thing: str() },
	members: { path: str(), skills: arr(Skill) },
});

/** The Pi's skills root: every set's folder is under it. */
export function skillsRoot(dataDir: string): string {
	return join(dataDir, "skills");
}

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
		self.on(path, ({ value }) => {
			watcher.value.watch(value);
			changes.set(changes.value + 1);
		});
		// Every change reads the folder again (changes during a read fold into one next read).
		self.on(changes, async () => {
			skills.set(await readSkills(root, path.value));
		});
		// A writable is the object's own; holders get a derived view of it.
		return { path, skills: self.derive([skills], ([value]) => [...value]) };
	});
}

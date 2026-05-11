import type { SessionInfo } from "../../core/session-manager.js";
import type { WebProjectInfo } from "./types.js";

export function groupSessionsByProject(sessions: SessionInfo[], currentCwd: string): WebProjectInfo[] {
	const projects = new Map<string, WebProjectInfo>();
	for (const session of sessions) {
		const cwd = session.cwd || "Unknown";
		let project = projects.get(cwd);
		if (!project) {
			project = { cwd, sessions: [] };
			projects.set(cwd, project);
		}
		project.sessions.push({
			path: session.path,
			id: session.id,
			cwd: session.cwd,
			name: session.name,
			firstMessage: session.firstMessage,
			modified: session.modified.toISOString(),
			created: session.created.toISOString(),
			messageCount: session.messageCount,
		});
	}
	if (currentCwd && !projects.has(currentCwd)) {
		projects.set(currentCwd, { cwd: currentCwd, sessions: [] });
	}
	return [...projects.values()]
		.map((project) => ({
			...project,
			sessions: project.sessions.sort(
				(a, b) => new Date(b.modified ?? 0).getTime() - new Date(a.modified ?? 0).getTime(),
			),
			modified: project.sessions[0]?.modified,
		}))
		.sort((a, b) => new Date(b.modified ?? 0).getTime() - new Date(a.modified ?? 0).getTime());
}

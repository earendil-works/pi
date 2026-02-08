import { isAbsolute, resolve } from "path";
import { findRepoRoot } from "../utils/find-repo-root.js";

export interface ResolveTodoRootParams {
	cwd: string;
	envTodoPath?: string | undefined;
	repoRoot?: string | null | undefined;
}

/**
 * Resolve the directory where todos are stored.
 *
 * Spec default: <repoRoot>/.mu/todos
 * Override: MU_TODO_PATH (absolute or repo-relative)
 */
export function resolveTodoRootDir(params: ResolveTodoRootParams): string {
	const repoRoot = params.repoRoot ?? findRepoRoot(params.cwd) ?? null;
	const env = params.envTodoPath?.trim();

	if (env) {
		if (isAbsolute(env)) {
			return resolve(env);
		}
		const base = repoRoot ?? params.cwd;
		return resolve(base, env);
	}

	const base = repoRoot ?? params.cwd;
	return resolve(base, ".mu", "todos");
}

export function getTodoRootDirForCwd(cwd: string): string {
	return resolveTodoRootDir({ cwd, envTodoPath: process.env.MU_TODO_PATH, repoRoot: findRepoRoot(cwd) });
}

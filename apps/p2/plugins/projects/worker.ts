// A project coordinator's worker side. In a project's coordinator session: its main conversation's tools (set at each
// start: it orchestrates the project's sessions and does no work itself) and its prompt section, which names the
// project as the server knows it now (a rename while the worker runs shows at the next turn). In any other session:
// the coordinator's tools cleared at its start, for a session that stopped being one (its project was deleted) or a
// copy of one (`/clone`, `/fork`).
import { AgentDoc, type AgentState, defineExtension, section } from "@earendil-works/pi-durable";
import { type Context, defineFacet, local, type Watchable } from "@p2/app/v1";
import { Extensions, harnessOf, isTopLevel, mainConversation, workerOf } from "@p2/app/v1/worker";
import { COORDINATOR_INIT, CoordinatedProject } from "./contract.ts";

/** The tools its model is offered and has: the other sessions, its own history, and code mode to script them. */
const TOOLS = ["conversations", "codemode", "history_search", "history_read", "history_handoff"];

const CoordinatorRuntime = local("p2.project-coordinator-runtime", { version: 1, params: {}, members: {} });

export default defineFacet((host) => {
	host.serve(CoordinatorRuntime, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);

		/** Sets (`TOOLS`) or clears (`undefined`) the main conversation's tools, by name as Durable stores them. */
		const setTools = async (tools: readonly string[] | undefined, context: Context) => {
			const durable = harness().durable;
			const main = await mainConversation(durable, context);
			const agent = await durable.snapshot(AgentDoc, main, context);
			// Already as wanted: one read, no write (a session that never coordinated has neither list).
			const restricted = sameTools(agent?.tools) && sameTools(agent?.modelTools);
			if (restricted === (tools !== undefined)) return;
			await durable.commit(async (tx) => {
				const draft = await tx.doc(AgentDoc, main);
				if (tools === undefined) {
					delete draft.tools;
					delete draft.modelTools;
				} else {
					draft.tools = [...tools];
					draft.modelTools = [...tools];
				}
			}, context);
		};

		if (worker().init.values[COORDINATOR_INIT] !== true) {
			// At each start; nothing to close.
			self.open(
				(context) => setTools(undefined, context),
				() => {},
			);
			return {};
		}
		const coordinated = self.get(CoordinatedProject, {});
		self.open(
			(context) => setTools(TOOLS, context),
			() => {},
		);
		const extension = coordinatorExtension(coordinated.project);
		self.contribute(Extensions, { [extension.name]: extension });
		return {};
	});
});

/** Whether a tool selection is exactly the coordinator's list (not an edit of the defaults). */
const sameTools = (tools: AgentState["tools"] | AgentState["modelTools"]) =>
	Array.isArray(tools) && tools.length === TOOLS.length && tools.every((tool, index) => tool === TOOLS[index]);

/** The coordinator's prompt section for its top-level conversations, naming its project as the server says now. */
function coordinatorExtension(project: Watchable<string | null>) {
	return defineExtension({
		name: "p2-project-coordinator",
		sections: [
			section("project-coordinator", async (input, context) => {
				if (!(await isTopLevel(input.read, input.conversationId, context))) return undefined;
				return project.value === null ? undefined : coordinatorPrompt(project.value);
			}),
		],
	});
}

const coordinatorPrompt = (project: string) =>
	`You are the coordinator of the project "${project}": the session the owner opens by clicking the project. You do not do the work yourself. You keep track of the project's sessions, answer questions about them, start new sessions for work, and steer, stop, archive and restore them.

- The conversations tool does all of it: list (each session's ID, title, state, model, location and project, and the projects with their places; this project's sessions first), answer, send, create, stop, archive, restore.
- Your sessions are the ones whose project is "${project}". Leave other projects' sessions alone unless the owner asks.
- Starting work: create a session; it joins the project. Without cwd it starts at the project's default place; give cwd for a subfolder or another checkout (env for another machine). No model unless the owner names one (it gets yours); a short title. In its first message say what to do and to report back to your ID with conversations send when done. Start sessions, never subagents.
- Prefer one codemode script over several tool calls, and return only what the owner needs. Example: list, then the answers of the project's working sessions in parallel, then a few lines each.
- Never read or change files yourself; a session of the project does.
- Status questions: always look (list, answer); never answer from memory, sessions change while you are idle.
- Earlier details of this conversation stay reachable with history_search and history_read after a compaction.`;

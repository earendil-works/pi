// Built-in job controls, live views, and completion notices for independently supervised work.
import { contentText } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { JobManager } from "../../core/jobs/manager.ts";
import { createJobsToolDefinition } from "../../core/jobs/tool.ts";
import { JobsView } from "../../core/jobs/view.ts";
import { generateDisplayName } from "../../core/naming.ts";
import { parsePaneCommand } from "../../core/panes/command.ts";
import { openPane, type PaneHandle, type PaneOptions } from "../../core/panes/host.ts";
import { getRexLocation } from "../../core/rex.ts";

const detailsValidator = Compile(
	Type.Object({ jobId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), jobState: Type.Optional(Type.String()) }),
);

/** Register persistent job management and /jobs using the shared Rex/TUI pane host. */
export function createJobsExtension(manager = new JobManager()): ExtensionFactory {
	return (pi) => {
		let lifetime = new AbortController();
		const panes = new Map<string, PaneHandle>();
		const openings = new Map<string, Promise<PaneHandle>>();
		const observers = new Map<string, () => void>();
		const namings = new Set<Promise<void>>();
		pi.registerTool(createJobsToolDefinition(process.cwd(), manager));

		async function present(
			ctx: ExtensionContext,
			options: Pick<PaneOptions, "backend" | "placement" | "minimized" | "fallback">,
			id?: string,
		): Promise<PaneHandle> {
			const signal = lifetime.signal;
			const key = id || ctx.cwd;
			const pending = openings.get(key);
			const existing = panes.get(key) ?? (pending ? await pending : undefined);
			if (existing) {
				const changeBackend = options.backend && options.backend !== "auto" && options.backend !== existing.backend;
				const changePlacement =
					options.placement && existing.backend === "rex" && options.placement !== existing.placement;
				if (!changeBackend && !changePlacement) {
					await existing.show();
					return existing;
				}
				await existing.close();
			}
			const opening = (async () => {
				const job = id ? await manager.inspect(id) : undefined;
				const project = job?.cwd ?? ctx.cwd;
				const pane = await openPane(ctx, {
					...options,
					title: job ? `Job ${job.id.slice(0, 8)} — ${job.name}` : "Background jobs",
					signal,
					create: (controls) =>
						new JobsView(
							manager,
							project,
							controls,
							(submitted) => {
								if (signal.aborted) return;
								if (submitted.runtime.state === "running" || submitted.runtime.state === "starting")
									observe(submitted.id, ctx);
								presentSubmitted(submitted.id, ctx);
								nameSubmitted(submitted.id, ctx);
							},
							id,
						),
				});
				panes.set(key, pane);
				void pane.closed.then(() => {
					if (panes.get(key) === pane) panes.delete(key);
				});
				return pane;
			})();
			openings.set(key, opening);
			try {
				return await opening;
			} finally {
				if (openings.get(key) === opening) openings.delete(key);
			}
		}

		function presentSubmitted(jobId: string, ctx: ExtensionContext): void {
			if (ctx.mode !== "tui" || lifetime.signal.aborted) return;
			const settings = ctx.ui.getRexSettings();
			if (
				!settings.enabled ||
				!settings.minimizedJobs ||
				!getRexLocation() ||
				panes.has(jobId) ||
				openings.has(jobId)
			)
				return;
			const owner = lifetime;
			// Presentation must not delay submission or change the independent job's lifecycle.
			void present(ctx, { backend: "rex", placement: "floating", minimized: true, fallback: "none" }, jobId).catch(
				(error: unknown) => {
					if (!owner.signal.aborted) ctx.ui.notify(`Cannot open job ${jobId} in Rex: ${String(error)}`, "warning");
				},
			);
		}
		function nameSubmitted(jobId: string, ctx: ExtensionContext): void {
			if (lifetime.signal.aborted || !ctx.model) return;
			const model = ctx.model;
			const owner = lifetime;
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const naming = (async () => {
				const job = await manager.claimName(jobId);
				if (job?.naming?.status !== "running") return;
				const request = ctx.sessionManager
					.getBranch()
					.findLast((entry) => entry.type === "message" && entry.message.role === "user");
				const intent =
					request?.type === "message" && request.message.role === "user"
						? contentText(request.message.content).slice(0, 6000)
						: "";
				const result = await generateDisplayName(ctx.modelRegistry.runtime, model, {
					kind: "job",
					subject: JSON.stringify({ command: job.command.slice(0, 6000), request: intent }),
					instructions: ctx.getSystemPrompt(),
					sessionId: `name:job:${job.id}`,
					signal: owner.signal,
				});
				if (
					result.response &&
					ctx.sessionManager.getSessionId() === sessionId &&
					ctx.sessionManager.getSessionFile() === sessionFile
				) {
					const response = result.response;
					pi.appendUsage("job_name", response.provider, response.model, response.usage, job.id);
				}
				await manager.finishName(
					jobId,
					owner.signal.aborted ? { status: "failed", error: "Name generation canceled" } : result,
				);
			})().catch((error: unknown) => {
				// Deleting a finished job also discards its pending name.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !owner.signal.aborted)
					ctx.ui.notify(`Cannot name job ${jobId}: ${String(error)}`, "warning");
			});
			namings.add(naming);
			void naming.then(() => namings.delete(naming));
		}

		pi.registerCommand("jobs", {
			description: "List and view persistent jobs: /jobs [--tui|--rex] [--split|--floating] [--minimized] [job ID]",
			handler: async (args, ctx) => {
				if (args.trim() === "--help") {
					ctx.ui.notify(
						"/jobs [--tui|--rex] [--split|--floating] [--minimized] [job ID]. New views use your Rex settings; explicit flags override them. Start jobs with bash async:true.",
						"info",
					);
					return;
				}
				const { options, text: id } = parsePaneCommand(args);
				await present(ctx, options, id || undefined);
			},
		});

		function observe(id: string, ctx: ExtensionContext) {
			if (observers.has(id)) return;
			const owner = lifetime;
			let checking = false;
			let dirty = false;
			let active = true;
			const clear = () => {
				active = false;
				observers.get(id)?.();
				observers.delete(id);
				ctx.ui.setStatus(
					"jobs",
					observers.size ? `${observers.size} background job${observers.size === 1 ? "" : "s"}` : undefined,
				);
			};
			async function check() {
				if (!active || owner.signal.aborted) return;
				if (checking) {
					dirty = true;
					return;
				}
				checking = true;
				try {
					const job = await manager.inspect(id);
					if (!active || owner.signal.aborted) return;
					if (
						job.runtime.state === "running" ||
						job.runtime.state === "starting" ||
						job.runtime.state === "unreachable"
					)
						return;
					clear();
					pi.sendMessage(
						{
							customType: "background-job",
							display: true,
							content: `Background job ${job.id} (${JSON.stringify(job.name)}): ${job.runtime.state}. Full output: ${job.logPath}`,
							details: { jobId: id, state: job.runtime.state },
						},
						{ triggerTurn: false },
					);
				} catch (error) {
					if (!active) return;
					clear();
					if (!owner.signal.aborted) ctx.ui.notify(`Cannot monitor job ${id}: ${String(error)}`, "warning");
				} finally {
					checking = false;
					if (dirty) {
						dirty = false;
						void check();
					}
				}
			}
			const watch = manager.watch(id, (file) => {
				if (file === undefined) {
					clear();
					if (!owner.signal.aborted)
						ctx.ui.notify(`Job ${id} lost its file watch; use jobs inspect to check its state`, "warning");
				} else if (file === "runtime.json") void check();
			});
			// File watches deliver normal completion; health checks also detect a crashed supervisor.
			const health = setInterval(() => {
				void check();
			}, 2000);
			health.unref();
			observers.set(id, () => {
				clearInterval(health);
				watch();
			});
			ctx.ui.setStatus("jobs", `${observers.size} background job${observers.size === 1 ? "" : "s"}`);
			void check();
		}

		pi.on("session_start", async (_event, ctx) => {
			if (lifetime.signal.aborted) lifetime = new AbortController();
			for (const job of await manager.list(ctx.cwd)) {
				if (job.runtime.state === "running" || job.runtime.state === "starting") observe(job.id, ctx);
			}
		});
		pi.on("tool_result", (event, ctx) => {
			if (event.toolName !== "bash" && event.toolName !== "jobs") return;
			// Trust boundary: extensions may override built-ins, so decode job metadata before acting.
			if (!detailsValidator.Check(event.details)) return;
			const { jobId, jobState } = event.details;
			if (!event.isError && (jobState === "running" || jobState === "starting")) observe(jobId, ctx);
			const submitted = event.toolName === "bash" ? event.input.async === true : event.input.action === "restart";
			if (submitted && !event.isError) {
				presentSubmitted(jobId, ctx);
				nameSubmitted(jobId, ctx);
			}
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			if (ctx.mode === "print" || ctx.mode === "json") await Promise.all(namings);
			lifetime.abort();
			for (const stop of observers.values()) stop();
			observers.clear();
			ctx.ui.setStatus("jobs", undefined);
			await Promise.all(namings);
			await Promise.allSettled([...openings.values()]);
			await Promise.all(
				[...panes.values()].map((pane) =>
					pane.close().catch((error: unknown) => ctx.ui.notify(String(error), "warning")),
				),
			);
			panes.clear();
		});
	};
}

export default createJobsExtension();

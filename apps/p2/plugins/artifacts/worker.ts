// Artifacts (worker): the agent's artifact tools, reaching the session's `Artifacts` on the server in roots of the
// worker's own (it acts as the session's worker there), and the new errors of open html pages, which ride along with the
// person's next message (`MessageContexts`).
import { type Ctx, contribute, defineFacet, expectVariant } from "@p2/app/v1";
import { Extensions, workerOf } from "@p2/app/v1/worker";
import { MessageContexts } from "../views/contract.ts";
import { Artifacts } from "./contract.ts";
import { createArtifactExtension } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.artifact-tools", (self) => {
		const worker = workerOf(self);
		const artifacts = async (ctx: Ctx) =>
			expectVariant(await ctx.get(Artifacts, { session: worker().init.values.session.id }), "worker");
		const root: ReturnType<typeof worker>["root"] = (fn, context) => worker().root(fn, context);
		const extension = createArtifactExtension({
			list: (context) => root(async (ctx) => (await artifacts(ctx)).list(ctx), context),
			read: (id, version, context) =>
				root(async (ctx) => (await artifacts(ctx)).read({ id, ...(version ? { version } : {}) }, ctx), context),
			write: (input, context) => root(async (ctx) => (await artifacts(ctx)).write(input, ctx), context),
			edit: (id, edits, context) =>
				root(async (ctx) => (await artifacts(ctx)).edit({ id, edits: [...edits] }, ctx), context),
			remove: async (id, context) => {
				await root(async (ctx) => (await artifacts(ctx)).remove({ id }, ctx), context);
			},
			state: (id, context) =>
				root(async (ctx) => (await (await artifacts(ctx)).readState({ id }, ctx)).state, context),
			setState: async (id, state, context) => {
				await root(async (ctx) => (await artifacts(ctx)).setState({ id, state }, ctx), context);
			},
			errors: (id, context) => root(async (ctx) => (await artifacts(ctx)).errors({ id }, ctx), context),
			logs: (id, since, context) =>
				root(
					async (ctx) => (await artifacts(ctx)).logs({ id, ...(since === undefined ? {} : { since }) }, ctx),
					context,
				),
			run: (id, code, context) => root(async (ctx) => (await artifacts(ctx)).eval({ id, code }, ctx), context),
		});
		self.contribute(Extensions, { [extension.name]: extension });
		// New errors of the session's open html pages go with the person's next message, once.
		self.contribute(MessageContexts, {
			artifacts: async (_input, ctx) => {
				const server = await artifacts(ctx);
				const { errors, marks } = await server.newErrors(ctx);
				if (!errors.length) return undefined;
				const text = [
					"<artifact-errors>",
					"New errors of html artifacts open on the person's devices (artifact_html_errors lists them; the text is the page's):",
					...errors.map((error) => `- ${error.id} (${error.title}): ${error.text}`),
					"</artifact-errors>",
				].join("\n");
				return {
					text,
					note: `${errors.length} page error${errors.length === 1 ? "" : "s"}`,
					carried: async (context) => {
						await (await artifacts(context)).carried({ marks }, context);
					},
				};
			},
		});
	});
});

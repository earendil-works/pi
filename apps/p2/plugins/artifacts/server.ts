// Artifacts (server): each session's artifacts in the server's store (`store.ts`, owned by `ArtifactStoreHost`), as
// `Artifacts` (people list, read and remove them; the session's worker does its agent's tools), each html artifact as
// the pages showing it hold it (`ArtifactPage`: its state, its side of the agent's requests, what it reports; the open
// pages kept by `pages.ts`), and `/artifact-frame`, which serves an html version into its sandboxed frame (`frame.ts`).
import { int, obj, str, unknown } from "@earendil-works/pi-schema";
import {
	type Ctx,
	canSend,
	canView,
	contribute,
	defineFacet,
	defineRegistry,
	deriveTyped,
	forbidden,
	isGuest,
	isOwner,
	isWorker,
	type JsonValue,
	keyed,
	local,
	method,
	nativeOf,
	propertiesOf,
	Session,
	serveNative,
	signalOf,
	unsafe,
	untilAborted,
} from "@p2/app/v1";
import { type RouteHandler, Routes, serverOf } from "@p2/app/v1/server";
import { Catalog, SessionCopied } from "../sessions/contract.ts";
import {
	ARTIFACT_ID,
	ArtifactPage,
	Artifacts,
	EditArgsSchema,
	type EvalResult,
	ReadArgsSchema,
	ReadSchema,
	WriteSchema,
} from "./contract.ts";
import { FRAME_CSP, framePage } from "./frame.ts";
import { PageRegistry } from "./pages.ts";
import {
	ArtifactStore,
	ArtifactsSchema,
	ArtifactsState,
	StatesSchema,
	StatesState,
	summariesOf,
	summaryOf,
	VersionRows,
} from "./store.ts";

/** The open pages of every artifact, for the objects below (one per server). */
const PagesNative = defineRegistry<PageRegistry, PageRegistry | undefined>("p2.artifact-pages", { version: 1 });

/** A session's ID where the store's methods take one. */
const SessionId = str({ minLength: 1, maxLength: 200 });

/**
 * Every session's artifacts in the server's store (server-internal, host lifetime): their documents keyed by session,
 * the reads and writes, and the open pages' registry (`PagesNative`).
 */
const ArtifactStoreHost = local("p2.artifact-store", {
	version: 1,
	params: {},
	members: {
		artifacts: keyed(ArtifactsSchema, Session),
		states: keyed(StatesSchema, Session),
		read: method(obj({ session: SessionId, ...propertiesOf(ReadArgsSchema) }), ReadSchema),
		write: method(obj({ session: SessionId, ...propertiesOf(WriteSchema) }), obj({ id: str(), version: int() })),
		edit: method(obj({ session: SessionId, ...propertiesOf(EditArgsSchema) }), obj({ version: int() })),
		remove: method(obj({ session: SessionId, id: str() })),
		copy: method(obj({ from: SessionId, to: SessionId })),
		readState: method(obj({ session: SessionId, id: str() }), obj({ state: unsafe<JsonValue>(unknown()) })),
		setState: method(obj({ session: SessionId, id: str(), state: unsafe<JsonValue>(unknown()) })),
	},
});

export default defineFacet((host) => {
	serveNative(host, PagesNative);
	host.serve(ArtifactStoreHost, (_params, self) => {
		const artifacts = self.state(ArtifactsState);
		const states = self.state(StatesState);
		const store = new ArtifactStore({
			artifacts,
			states,
			versions: self.table(VersionRows),
			tx: (fn, context) => self.tx(fn, context),
		});
		self.contribute(PagesNative, new PageRegistry());
		return {
			artifacts,
			states,
			read: ({ session, id, version }, ctx) => store.read(session, id, version, ctx),
			write: ({ session, ...input }, ctx) => store.write(session, input, Date.now(), ctx),
			edit: ({ session, id, edits }, ctx) => store.edit(session, id, edits, Date.now(), ctx),
			remove: async ({ session, id }, ctx) => {
				await store.remove(session, id, ctx);
				return null;
			},
			copy: async ({ from, to }, ctx) => {
				await store.copy(from, to, ctx);
				return null;
			},
			readState: async ({ session, id }, ctx) => ({ state: await store.state(session, id, ctx) }),
			setState: async ({ session, id, state }, ctx) => {
				await store.setState(session, id, state, ctx);
				return null;
			},
		};
	});

	host.serve(Artifacts, ({ session }, principal, self) => {
		const worker = isWorker(principal) && principal.session === session;
		if (!worker && !canView(principal, session)) throw forbidden("the session's viewers and worker only");
		const store = self.get(ArtifactStoreHost, {});
		const pages = nativeOf(self, PagesNative, "The artifact pages");
		const artifacts = deriveTyped(self, [store.artifacts.at(Session({ id: session }))], ([doc]) => summariesOf(doc));
		const read = ({ id, version }: { id: string; version?: number }, ctx: Ctx) =>
			store.read({ session, id, ...(version === undefined ? {} : { version }) }, ctx);
		const remove = async ({ id }: { id: string }, ctx: Ctx) => {
			await store.remove({ session, id }, ctx);
			pages().forget(session, id);
			return null;
		};
		if (worker)
			return {
				variant: "worker",
				members: {
					list: async () => [...artifacts.value],
					read,
					write: (input, ctx) => store.write({ session, ...input }, ctx),
					edit: (args, ctx) => store.edit({ session, ...args }, ctx),
					remove,
					readState: ({ id }, ctx) => store.readState({ session, id }, ctx),
					setState: ({ id, state }, ctx) => store.setState({ session, id, state }, ctx),
					errors: async ({ id }) => pages().errors(session, id),
					logs: async ({ id, since }) => pages().logs(session, id, since ?? 0),
					eval: async ({ id, code }, ctx) => {
						await read({ id }, ctx);
						return pages().run(session, id, code, signalOf(ctx));
					},
					newErrors: async () => {
						const { errors, marks } = pages().uncarried(session);
						const titles = new Map(artifacts.value.map((each) => [each.id, each.title]));
						return {
							errors: errors.map((error) => ({ ...error, title: titles.get(error.id) ?? error.id })),
							marks,
						};
					},
					carried: async ({ marks }) => {
						pages().carried(session, marks);
						return null;
					},
				},
			};
		if (!canSend(principal, session) || (!isOwner(principal) && !isGuest(principal)))
			return { variant: "reader", members: { artifacts, read } };
		return { variant: "editor", members: { artifacts, read, remove } };
	});

	host.serve(ArtifactPage, ({ session, id }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("the session's viewers only");
		if (!ARTIFACT_ID.test(id)) throw forbidden("no such artifact");
		const store = self.get(ArtifactStoreHost, {});
		const pages = nativeOf(self, PagesNative, "The artifact pages");
		const address = Session({ id: session });
		const summary = deriveTyped(self, [store.artifacts.at(address)], ([doc]) => {
			const stored = doc.artifacts[id];
			return stored ? summaryOf(id, stored) : null;
		});
		const value = deriveTyped(self, [store.states.at(address)], ([doc]) => doc.states[id] ?? null);
		const request = self.events<{ request: string; code: string }>();
		// Open while some browser holds it live: the agent's requests go to it.
		self.onLive(async (ctx) => {
			const close = pages().open(session, id, { run: (asked) => request.emit(asked) });
			try {
				await untilAborted(ctx);
			} finally {
				close();
			}
		});
		const report = async ({
			errors,
			logs,
		}: {
			errors: readonly string[];
			logs: readonly { level: string; text: string }[];
		}) => {
			pages().report(session, id, errors, logs);
			return null;
		};
		const answer = async ({ request: asked, result }: { request: string; result: EvalResult }) => {
			pages().answer(asked, result);
			return null;
		};
		const members = { summary, value, request, report, answer };
		if (!canSend(principal, session) || (!isOwner(principal) && !isGuest(principal)))
			return { variant: "viewer", members };
		return {
			variant: "editor",
			members: { ...members, setState: ({ state: next }, ctx) => store.setState({ session, id, state: next }, ctx) },
		};
	});

	// A copy of a session (clone, fork) takes its artifacts along: its history's cards show them.
	contribute(host, "p2.artifacts-copied", (self) => {
		const store = self.get(ArtifactStoreHost, {});
		self.contribute(SessionCopied, {
			artifacts: (from, to, ctx) =>
				store
					.copy({ from, to }, ctx)
					.then(() => {})
					.catch((error: unknown) => console.error(`p2 artifacts: session ${to} got no artifacts:`, error)),
		});
	});

	contribute(host, "p2.artifact-frames", (self) => {
		const server = serverOf(self);
		const catalog = self.get(Catalog, {});
		const serve: RouteHandler = async (request, response, { principal, origin }, outer) => {
			const query = new URL(request.url ?? "/", "http://localhost").searchParams;
			const session = query.get("session") ?? "";
			if (!canView(principal, session) || request.headers["sec-fetch-site"] === "cross-site") {
				response.writeHead(403);
				response.end("Forbidden");
				return;
			}
			const id = query.get("id") ?? "";
			const version = Number(query.get("version"));
			try {
				if (!ARTIFACT_ID.test(id) || !Number.isSafeInteger(version) || version < 1) throw new Error("invalid");
				// Read in a root of the server's own, after the viewer was authorized above.
				const read = await server().root(async (ctx) => {
					const row = await catalog.get({ id: session }, ctx).catch(() => undefined);
					if (row === undefined) throw new Error("unknown session");
					return (await ctx.get(ArtifactStoreHost, {})).read({ session, id, version }, ctx);
				}, outer);
				if (read.summary.kind !== "html") throw new Error("not a page");
				const body = Buffer.from(framePage(read.content), "utf8");
				response.writeHead(200, {
					// `frame-ancestors` checks every ancestor: through Radius the app sits in the Radius shell's frame.
					"Content-Security-Policy": `${FRAME_CSP}; frame-ancestors 'self'${
						origin.relayShellOrigin === undefined ? "" : ` ${origin.relayShellOrigin}`
					}`,
					"Content-Type": "text/html; charset=utf-8",
					"Content-Length": body.byteLength,
					"Cross-Origin-Resource-Policy": "same-origin",
					// A removed artifact's ID may be written again: never cache.
					"Cache-Control": "no-store",
				});
				response.end(request.method === "HEAD" ? undefined : body);
			} catch {
				if (response.headersSent) response.destroy();
				else {
					response.writeHead(404);
					response.end("Artifact not found");
				}
			}
		};
		self.contribute(Routes, { "GET /artifact-frame": serve, "HEAD /artifact-frame": serve });
	});
});

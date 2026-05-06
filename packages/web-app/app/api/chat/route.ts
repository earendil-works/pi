import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ChatRequest, ChatStreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseChatRequest(body: unknown): ChatRequest {
	if (!isRecord(body) || typeof body.message !== "string") {
		throw new Error("Chat request requires a message");
	}
	const images = Array.isArray(body.images)
		? body.images.filter(isRecord).map((image) => {
				if (typeof image.data !== "string" || typeof image.mimeType !== "string") {
					throw new Error("Images require data and mimeType");
				}
				return {
					data: image.data,
					mimeType: image.mimeType,
					name: typeof image.name === "string" ? image.name : undefined,
				};
			})
		: undefined;
	const streamingBehavior =
		body.streamingBehavior === "followUp" ? "followUp" : body.streamingBehavior === "steer" ? "steer" : undefined;
	return {
		message: body.message,
		images,
		streamingBehavior,
	};
}

export async function POST(request: Request): Promise<Response> {
	let chatRequest: ChatRequest;
	try {
		chatRequest = parseChatRequest(await request.json());
	} catch (error) {
		return Response.json({ error: toErrorMessage(error) }, { status: 400 });
	}

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: ChatStreamEvent) => {
				controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			};

			try {
				const { getPiWebRuntime, getWebState, toImageContent } = await import("@/lib/runtime");
				const webRuntime = await getPiWebRuntime();
				const session = webRuntime.runtime.session;
				unsubscribe = session.subscribe((event: AgentSessionEvent) => send({ type: "agent_event", event }));
				send({ type: "state", state: await getWebState() });

				await session.prompt(chatRequest.message, {
					images: toImageContent(chatRequest.images),
					streamingBehavior: session.isStreaming
						? (chatRequest.streamingBehavior ?? "steer")
						: chatRequest.streamingBehavior,
					preflightResult: (success: boolean) => send({ type: "preflight", success }),
				});

				send({ type: "done", state: await getWebState() });
			} catch (error) {
				const state = await import("@/lib/runtime").then(({ getWebState }) => getWebState()).catch(() => undefined);
				send({ type: "error", error: toErrorMessage(error), state });
			} finally {
				unsubscribe?.();
				controller.close();
			}
		},
		cancel() {
			unsubscribe?.();
		},
	});

	return new Response(stream, {
		headers: {
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"Content-Type": "application/x-ndjson; charset=utf-8",
		},
	});
}

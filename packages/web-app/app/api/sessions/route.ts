export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function GET(): Promise<Response> {
	try {
		const { getWebState } = await import("@/lib/runtime");
		const state = await getWebState();
		return Response.json({ sessions: state.sessions });
	} catch (error) {
		return Response.json({ error: toErrorMessage(error) }, { status: 500 });
	}
}

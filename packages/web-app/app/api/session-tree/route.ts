export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function GET(): Promise<Response> {
	try {
		const { getPiWebRuntime } = await import("@/lib/runtime");
		const { runtime } = await getPiWebRuntime();
		return Response.json({
			leafId: runtime.session.sessionManager.getLeafId(),
			tree: runtime.session.sessionManager.getTree(),
		});
	} catch (error) {
		return Response.json({ error: toErrorMessage(error) }, { status: 500 });
	}
}

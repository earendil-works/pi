export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function POST(request: Request): Promise<Response> {
	try {
		const { runControlAction } = await import("@/lib/runtime");
		const body: unknown = await request.json();
		return Response.json(await runControlAction(body));
	} catch (error) {
		return Response.json({ error: toErrorMessage(error) }, { status: 400 });
	}
}

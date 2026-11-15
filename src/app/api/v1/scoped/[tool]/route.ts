import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { verifyToken } from "@/lib/scoped-tokens/service";
import { dispatchScopedTool } from "@/lib/scoped/dispatch";

type RouteContext = { params: Promise<{ tool: string }> };

/**
 * The scoped automation surface (agentic-inbox contract): bearer auth with
 * an ain1 mailbox token or an ain2 app token, body = tool arguments. No
 * session or origin check — possession of the token is the authorization.
 */
export async function POST(request: Request, context: RouteContext) {
	const authorization = request.headers.get("Authorization") ?? "";
	if (!authorization.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const env = getEnv();
	const verified = await verifyToken(getDb(env), authorization.slice(7));
	if (!verified) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await dispatchScopedTool(env, verified, (await context.params).tool, body ?? {});
	return NextResponse.json(result.body, { status: result.status });
}
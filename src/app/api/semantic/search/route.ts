import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { resolveEmbedder, semanticSearch, SEMANTIC_NOT_CONFIGURED } from "@/lib/semantic/service";
import { loadMailbox } from "../../utils/mailbox";

/** Meaning-based search: `{ mailboxId, query, limit? }`. Read-only. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; query?: unknown; limit?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId);
	if ("error" in loaded) return loaded.error;
	const query = typeof body?.query === "string" ? body.query : "";
	if (!query.trim()) return NextResponse.json({ error: "query is required" }, { status: 400 });
	const embedder = resolveEmbedder(getEnv());
	if (!embedder) return NextResponse.json({ error: SEMANTIC_NOT_CONFIGURED, code: "SEMANTIC_NOT_CONFIGURED" }, { status: 503 });
	try {
		const results = await semanticSearch(loaded.db, loaded.mailboxId, query, embedder, typeof body?.limit === "number" ? body.limit : 10);
		return NextResponse.json({ results });
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Semantic search failed" }, { status: 502 });
	}
}
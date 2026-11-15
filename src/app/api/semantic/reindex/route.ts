import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { reindexBatch, resolveEmbedder, SEMANTIC_NOT_CONFIGURED } from "@/lib/semantic/service";
import { loadMailbox } from "../../utils/mailbox";

/** Embed one bounded batch of unembedded/changed mail: `{ mailboxId, limit? }`. Loop while remaining > 0. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; limit?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	const embedder = resolveEmbedder(getEnv());
	if (!embedder) return NextResponse.json({ error: SEMANTIC_NOT_CONFIGURED, code: "SEMANTIC_NOT_CONFIGURED" }, { status: 503 });
	try {
		const result = await reindexBatch(loaded.db, loaded.mailboxId, embedder, typeof body?.limit === "number" ? body.limit : undefined);
		return NextResponse.json(result);
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Reindex failed" }, { status: 502 });
	}
}
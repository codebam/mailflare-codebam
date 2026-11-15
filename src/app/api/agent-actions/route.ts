import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { listActions } from "@/lib/agent-actions/service";
import { loadMailbox } from "../utils/mailbox";

/** Recent mutating tool calls, newest first: `?mailboxId=&limit=`. */
export async function GET(request: Request) {
	const url = new URL(request.url);
	const loaded = await loadMailbox(request, url.searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	const limit = Number(url.searchParams.get("limit") ?? 50);
	try {
		return NextResponse.json(await listActions(loaded.db, loaded.mailboxId, Number.isFinite(limit) ? limit : 50));
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ actions: [], total: 0 });
		throw error;
	}
}
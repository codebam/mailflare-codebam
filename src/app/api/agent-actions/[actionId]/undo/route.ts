import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { undoAction } from "@/lib/agent-actions/service";
import { loadMailbox, migrationRequired } from "../../../utils/mailbox";

type RouteContext = { params: Promise<{ actionId: string }> };

/** Undo one recorded action: `{ mailboxId }`. Restores folder/read/star; never sends or deletes. */
export async function POST(request: Request, context: RouteContext) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await undoAction(loaded.db, loaded.mailboxId, (await context.params).actionId);
		if (result.ok) return NextResponse.json({ action: result.action });
		const status = result.error === "not_found" ? 404 : result.error === "message_gone" ? 410 : 409;
		const message = result.error === "not_found" ? "Action not found" : result.error === "not_undoable" ? "This action cannot be undone" : result.error === "already_undone" ? "This action was already undone" : "The message no longer exists";
		return NextResponse.json({ error: message }, { status });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
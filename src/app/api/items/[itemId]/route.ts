import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { updateItem } from "@/lib/items/service";
import { loadMailbox, migrationRequired } from "../../utils/mailbox";
import { itemError } from "../utils";

type RouteContext = { params: Promise<{ itemId: string }> };

/** Updates an item: `{ mailboxId, status?, title?, details?, dueAt? }`. */
export async function PATCH(request: Request, context: RouteContext) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	const input: { status?: string; title?: string; details?: string | null; dueAt?: Date | null } = {};
	if (typeof body?.status === "string") input.status = body.status;
	if (typeof body?.title === "string") input.title = body.title;
	if (body?.details === null || typeof body?.details === "string") input.details = body.details;
	if (body?.dueAt === null) input.dueAt = null;
	else if (typeof body?.dueAt === "string") {
		const dueAt = new Date(body.dueAt);
		if (Number.isNaN(dueAt.getTime())) return NextResponse.json({ error: "dueAt must be an ISO 8601 timestamp" }, { status: 400 });
		input.dueAt = dueAt;
	}
	try {
		const result = await updateItem(loaded.db, loaded.mailboxId, (await context.params).itemId, input);
		return result.ok ? NextResponse.json({ item: result.item }) : itemError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
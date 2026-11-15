import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { createItem, listItems } from "@/lib/items/service";
import type { ItemDueBucket, ItemStatus } from "@/lib/items/item-utils";
import { loadMailbox, migrationRequired } from "../utils/mailbox";
import { itemError } from "./utils";

/** Lists items: `?mailboxId=&status=&due=`. */
export async function GET(request: Request) {
	const url = new URL(request.url);
	const loaded = await loadMailbox(request, url.searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	const status = url.searchParams.get("status");
	const due = url.searchParams.get("due");
	try {
		const items = await listItems(loaded.db, loaded.mailboxId, {
			status: status === "open" || status === "done" || status === "dismissed" ? (status as ItemStatus) : undefined,
			due: due === "overdue" || due === "today" || due === "upcoming" || due === "none" ? (due as ItemDueBucket) : undefined,
		});
		return NextResponse.json({ items });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ items: [] });
		throw error;
	}
}

/** Creates an item: `{ mailboxId, title, kind?, details?, dueAt?, messageId? }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	const dueAt = typeof body?.dueAt === "string" ? new Date(body.dueAt) : null;
	if (dueAt && Number.isNaN(dueAt.getTime())) return NextResponse.json({ error: "dueAt must be an ISO 8601 timestamp" }, { status: 400 });
	try {
		const result = await createItem(loaded.db, loaded.mailboxId, {
			title: typeof body?.title === "string" ? body.title : "",
			kind: typeof body?.kind === "string" ? body.kind : undefined,
			details: typeof body?.details === "string" ? body.details : null,
			dueAt,
			messageId: typeof body?.messageId === "string" ? body.messageId : null,
		});
		return result.ok ? NextResponse.json({ item: result.item }, { status: 201 }) : itemError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
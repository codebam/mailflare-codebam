import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { messages } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import { muteThread, unmuteThread } from "@/lib/mute/service";
import { loadMailbox, migrationRequired } from "../../utils/mailbox";

/** Accept a thread id or any message id of the thread; resolve to the conversation key. */
async function threadKeyFor(loaded: { db: import("@/db").AppDatabase; mailboxId: string }, threadId: string) {
	const [row] = await loaded.db.select({ threadId: messages.threadId }).from(messages).where(and(eq(messages.id, threadId), eq(messages.mailboxId, loaded.mailboxId))).limit(1);
	return row ? (row.threadId ?? threadId) : threadId;
}

/** Mute a thread: `{ mailboxId, threadId }`. Idempotent; nothing is deleted. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; threadId?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	const threadId = typeof body?.threadId === "string" ? body.threadId : "";
	if (!threadId) return NextResponse.json({ error: "threadId is required" }, { status: 400 });
	try {
		await muteThread(loaded.db, loaded.mailboxId, await threadKeyFor(loaded, threadId));
		return NextResponse.json({ muted: true });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

/** Unmute a thread: `?mailboxId=&threadId=`. Idempotent. */
export async function DELETE(request: Request) {
	const url = new URL(request.url);
	const loaded = await loadMailbox(request, url.searchParams.get("mailboxId"), true);
	if ("error" in loaded) return loaded.error;
	const threadId = url.searchParams.get("threadId") ?? "";
	if (!threadId) return NextResponse.json({ error: "threadId is required" }, { status: 400 });
	try {
		await unmuteThread(loaded.db, loaded.mailboxId, await threadKeyFor(loaded, threadId));
		return NextResponse.json({ muted: false });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
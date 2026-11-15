import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mutedThreads } from "@/db/schema";
import { newId } from "@/lib/ids";

/**
 * Muted conversations. Muting is idempotent; new mail in a muted thread still
 * arrives and classifies, but notification fan-out skips it. The thread key is
 * the message list's conversation key: the thread id, or the lone message's id.
 */

export async function muteThread(db: AppDatabase, mailboxId: string, threadKey: string): Promise<void> {
	if (!threadKey) return;
	await db.insert(mutedThreads).values({ id: newId("mute"), mailboxId, threadKey }).onConflictDoNothing();
}

export async function unmuteThread(db: AppDatabase, mailboxId: string, threadKey: string): Promise<void> {
	await db.delete(mutedThreads).where(and(eq(mutedThreads.mailboxId, mailboxId), eq(mutedThreads.threadKey, threadKey)));
}

export async function isThreadMuted(db: AppDatabase, mailboxId: string, threadKey: string): Promise<boolean> {
	const [row] = await db.select({ id: mutedThreads.id }).from(mutedThreads).where(and(eq(mutedThreads.mailboxId, mailboxId), eq(mutedThreads.threadKey, threadKey))).limit(1);
	return !!row;
}

/** Thread keys the notification fan-out should skip for this mailbox. */
export async function listMutedThreadKeys(db: AppDatabase, mailboxId: string): Promise<string[]> {
	const rows = await db.select({ threadKey: mutedThreads.threadKey }).from(mutedThreads).where(eq(mutedThreads.mailboxId, mailboxId)).orderBy(asc(mutedThreads.createdAt));
	return rows.map((row) => row.threadKey);
}
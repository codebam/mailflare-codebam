import { and, count, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messageAttachments, messages } from "@/db/schema";

/**
 * Per-mailbox storage footprint: stored message count and attachment
 * count/bytes. The database is shared across mailboxes, so per-mailbox
 * database bytes are not measurable; attachment bytes are the dominant
 * per-mailbox cost and are reported exactly.
 */
export type MailboxStorage = {
	mailboxId: string;
	messages: number;
	attachments: { count: number; bytes: number };
};

export async function getMailboxStorage(db: AppDatabase, mailboxId: string): Promise<MailboxStorage> {
	const [messageCount] = await db.select({ value: count() }).from(messages).where(eq(messages.mailboxId, mailboxId));
	const [attachmentStats] = await db
		.select({ count: count(), bytes: sql<number>`coalesce(sum(${messageAttachments.size}), 0)` })
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(eq(messages.mailboxId, mailboxId));
	return {
		mailboxId,
		messages: Number(messageCount?.value ?? 0),
		attachments: { count: Number(attachmentStats?.count ?? 0), bytes: Number(attachmentStats?.bytes ?? 0) },
	};
}
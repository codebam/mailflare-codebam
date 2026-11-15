import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { reconstructedMessage } from "./eml-utils";

/**
 * One stored message as a reconstructed RFC 5322 (EML) block, rebuilt from
 * the stored fields — never the wire source. Returns null when the message
 * is not in this mailbox.
 */
export async function exportEmail(db: AppDatabase, mailboxId: string, emailId: string): Promise<{ eml: string; subject: string | null } | null> {
	const [row] = await db
		.select({
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			ccAddr: messages.ccAddr,
			subject: messages.subject,
			providerMessageId: messages.providerMessageId,
			textBody: messages.textBody,
			htmlBody: messages.htmlBody,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.where(and(eq(messages.id, emailId), eq(messages.mailboxId, mailboxId)))
		.limit(1);
	if (!row) return null;
	const eml = reconstructedMessage({
		sender: row.fromAddr,
		recipient: row.toAddr,
		cc: row.ccAddr,
		date: row.createdAt.toUTCString(),
		subject: row.subject,
		message_id: row.providerMessageId,
		body: row.textBody ?? row.htmlBody,
	});
	return { eml, subject: row.subject };
}
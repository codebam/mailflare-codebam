import { and, count, eq, gte, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { followUps, items, messages } from "@/db/schema";

/**
 * The trailing-24-hour brief: arrivals, what still needs a reply, the
 * category breakdown, and the tasks/reminders due. Computed on demand;
 * nothing is stored or sent.
 */
export type Digest = {
	period: { from: string; to: string };
	arrivals: number;
	sent: number;
	spam: number;
	needsReply: number;
	recent: Array<{ id: string; subject: string | null; from: string; date: string }>;
	categories: Array<{ category: string; count: number }>;
	itemsDue: Array<{ id: string; title: string; dueAt: string | null; status: string }>;
	remindersDue: number;
};

export async function getDigest(db: AppDatabase, mailboxId: string, now = new Date()): Promise<Digest> {
	const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const inPeriod = and(eq(messages.mailboxId, mailboxId), gte(messages.createdAt, from), lte(messages.createdAt, now));
	const [arrivals] = await db.select({ value: count() }).from(messages).where(and(inPeriod, eq(messages.direction, "inbound"), eq(messages.status, "received")));
	const [sent] = await db.select({ value: count() }).from(messages).where(and(inPeriod, eq(messages.direction, "outbound"), eq(messages.status, "sent")));
	const [spam] = await db.select({ value: count() }).from(messages).where(and(inPeriod, eq(messages.status, "spam")));
	const [needsReply] = await db.select({ value: count() }).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.direction, "inbound"), eq(messages.status, "received"), eq(messages.read, false)));
	const recent = await db
		.select({ id: messages.id, subject: messages.subject, fromAddr: messages.fromAddr, createdAt: messages.createdAt })
		.from(messages)
		.where(and(inPeriod, eq(messages.direction, "inbound")))
		.orderBy(sql`${messages.createdAt} desc`)
		.limit(10);
	const categoryRows = await db
		.select({ category: messages.category, value: count() })
		.from(messages)
		.where(and(inPeriod, eq(messages.direction, "inbound")))
		.groupBy(messages.category);
	const endOfDay = new Date(now);
	endOfDay.setHours(23, 59, 59, 999);
	const dueItems = await db
		.select({ id: items.id, title: items.title, dueAt: items.dueAt, status: items.status })
		.from(items)
		.where(and(eq(items.mailboxId, mailboxId), eq(items.status, "open"), lte(items.dueAt, endOfDay)))
		.orderBy(sql`${items.dueAt} asc`)
		.limit(50);
	const [reminders] = await db
		.select({ value: count() })
		.from(followUps)
		.innerJoin(messages, eq(followUps.messageId, messages.id))
		.where(and(eq(messages.mailboxId, mailboxId), eq(followUps.status, "due")));
	return {
		period: { from: from.toISOString(), to: now.toISOString() },
		arrivals: Number(arrivals?.value ?? 0),
		sent: Number(sent?.value ?? 0),
		spam: Number(spam?.value ?? 0),
		needsReply: Number(needsReply?.value ?? 0),
		recent: recent.map((row) => ({ id: row.id, subject: row.subject, from: row.fromAddr, date: row.createdAt.toISOString() })),
		categories: categoryRows.filter((row) => row.category).map((row) => ({ category: row.category as string, count: Number(row.value) })),
		itemsDue: dueItems.map((row) => ({ id: row.id, title: row.title, dueAt: row.dueAt ? row.dueAt.toISOString() : null, status: row.status })),
		remindersDue: Number(reminders?.value ?? 0),
	};
}
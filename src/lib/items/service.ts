import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { items } from "@/db/schema";
import { newId } from "@/lib/ids";
import { ITEM_KINDS, ITEM_STATUSES, MAX_ITEM_DETAILS_LENGTH, MAX_ITEM_TITLE_LENGTH, itemDueBucket, type ItemKind, type ItemStatus } from "./item-utils";
import type { Item, ItemListFilter, ItemResult } from "./types";

/**
 * Tasks and deadlines extracted from mail (or added by hand). The AI
 * extractor creates them; operators and agents move them between open, done
 * and dismissed. Nothing here sends mail.
 */

export async function listItems(db: AppDatabase, mailboxId: string, filter: ItemListFilter = {}, now = new Date()): Promise<Item[]> {
	const conditions = [eq(items.mailboxId, mailboxId)];
	if (filter.status) conditions.push(eq(items.status, filter.status));
	const rows = await db.select().from(items).where(and(...conditions)).orderBy(asc(items.dueAt), asc(items.createdAt), asc(items.id));
	const mapped = rows.map(toItem);
	if (!filter.due) return mapped;
	return mapped.filter((item) => itemDueBucket(item.dueAt ? new Date(item.dueAt) : null, now) === filter.due);
}

export async function createItem(
	db: AppDatabase,
	mailboxId: string,
	input: { messageId?: string | null; kind?: string; title: string; details?: string | null; dueAt?: Date | null },
): Promise<ItemResult> {
	const invalid = validateItem(input);
	if (invalid) return { ok: false, error: invalid };
	const id = newId("item");
	await db.insert(items).values({
		id,
		mailboxId,
		messageId: input.messageId ?? null,
		kind: (input.kind ?? "task") as ItemKind,
		title: input.title.trim(),
		details: input.details ?? null,
		dueAt: input.dueAt ?? null,
	});
	const [row] = await db.select().from(items).where(eq(items.id, id)).limit(1);
	return row ? { ok: true, item: toItem(row) } : { ok: false, error: "not_found" };
}

export async function updateItem(
	db: AppDatabase,
	mailboxId: string,
	itemId: string,
	input: { status?: string; title?: string; details?: string | null; dueAt?: Date | null },
): Promise<ItemResult> {
	const [row] = await db.select().from(items).where(and(eq(items.id, itemId), eq(items.mailboxId, mailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	if (input.status !== undefined && !ITEM_STATUSES.includes(input.status as ItemStatus)) return { ok: false, error: "invalid_status" };
	const merged = {
		kind: row.kind,
		title: input.title ?? row.title,
		details: input.details !== undefined ? input.details : row.details,
	};
	const invalid = validateItem(merged);
	if (invalid) return { ok: false, error: invalid };
	await db.update(items).set({
		...(input.status !== undefined ? { status: input.status as ItemStatus } : {}),
		title: merged.title.trim(),
		details: merged.details,
		...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
		updatedAt: new Date(),
	}).where(eq(items.id, itemId));
	const [updated] = await db.select().from(items).where(eq(items.id, itemId)).limit(1);
	return updated ? { ok: true, item: toItem(updated) } : { ok: false, error: "not_found" };
}

function validateItem(input: { kind?: string; title: string; details?: string | null }): "invalid_title" | "invalid_details" | "invalid_kind" | null {
	if (input.kind !== undefined && !ITEM_KINDS.includes(input.kind as ItemKind)) return "invalid_kind";
	const title = input.title.trim();
	if (!title || title.length > MAX_ITEM_TITLE_LENGTH) return "invalid_title";
	if (input.details != null && input.details.length > MAX_ITEM_DETAILS_LENGTH) return "invalid_details";
	return null;
}

function toItem(row: typeof items.$inferSelect): Item {
	return {
		id: row.id,
		messageId: row.messageId,
		kind: row.kind,
		title: row.title,
		details: row.details,
		dueAt: row.dueAt ? row.dueAt.toISOString() : null,
		status: row.status,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
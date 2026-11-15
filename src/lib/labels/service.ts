import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { labels, messageLabels, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { LABEL_NAME_MAX_LENGTH, LABELS_PER_MAILBOX_MAX, isValidLabelColor, labelNameKey, normalizeLabelName } from "./label-utils";
import type { Label, LabelResult, MessageLabelsResult } from "./types";

/** Every label of the mailbox, ordered by name (case-insensitive). */
export async function listLabels(db: AppDatabase, mailboxId: string): Promise<Label[]> {
	const rows = await db.select().from(labels).where(eq(labels.mailboxId, mailboxId)).orderBy(asc(labels.nameKey), asc(labels.id));
	return rows.map(toLabel);
}

/** Creates a label; names are unique per mailbox case-insensitively, up to the mailbox cap. */
export async function createLabel(db: AppDatabase, mailboxId: string, input: { name: string; color?: string | null }): Promise<LabelResult> {
	const name = normalizeLabelName(input.name);
	if (!name || name.length > LABEL_NAME_MAX_LENGTH) return { ok: false, error: "invalid_name" };
	const color = input.color ?? null;
	if (color !== null && !isValidLabelColor(color)) return { ok: false, error: "invalid_color" };
	const existing = await listLabels(db, mailboxId);
	if (existing.length >= LABELS_PER_MAILBOX_MAX) return { ok: false, error: "limit_reached" };
	if (existing.some((label) => labelNameKey(label.name) === labelNameKey(name))) return { ok: false, error: "name_taken" };
	const id = newId("label");
	await db.insert(labels).values({ id, mailboxId, name, nameKey: labelNameKey(name), color });
	const [row] = await db.select().from(labels).where(eq(labels.id, id)).limit(1);
	return row ? { ok: true, label: toLabel(row) } : { ok: false, error: "not_found" };
}

/** Renames and/or recolors a label. Omitted fields keep their value; an explicit null color clears it. */
export async function updateLabel(
	db: AppDatabase,
	mailboxId: string,
	labelId: string,
	input: { name?: string; color?: string | null },
): Promise<LabelResult> {
	const [row] = await db.select().from(labels).where(and(eq(labels.id, labelId), eq(labels.mailboxId, mailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	const set: { name?: string; nameKey?: string; color?: string | null } = {};
	if (input.name !== undefined) {
		const name = normalizeLabelName(input.name);
		if (!name || name.length > LABEL_NAME_MAX_LENGTH) return { ok: false, error: "invalid_name" };
		const key = labelNameKey(name);
		if (key !== row.nameKey) {
			const [taken] = await db.select({ id: labels.id }).from(labels).where(and(eq(labels.mailboxId, mailboxId), eq(labels.nameKey, key))).limit(1);
			if (taken) return { ok: false, error: "name_taken" };
		}
		set.name = name;
		set.nameKey = key;
	}
	if (input.color !== undefined) {
		if (input.color !== null && !isValidLabelColor(input.color)) return { ok: false, error: "invalid_color" };
		set.color = input.color;
	}
	if (Object.keys(set).length > 0) await db.update(labels).set(set).where(eq(labels.id, labelId));
	const [updated] = await db.select().from(labels).where(eq(labels.id, labelId)).limit(1);
	return updated ? { ok: true, label: toLabel(updated) } : { ok: false, error: "not_found" };
}

/** Deletes a label; the join rows cascade, detaching it from every message. */
export async function deleteLabel(db: AppDatabase, mailboxId: string, labelId: string): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
	const [row] = await db.select({ id: labels.id }).from(labels).where(and(eq(labels.id, labelId), eq(labels.mailboxId, mailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	await db.delete(labels).where(eq(labels.id, labelId));
	return { ok: true };
}

/** Resolves a label by id or by name (case-insensitive); the agent tools accept either. */
export async function resolveLabel(db: AppDatabase, mailboxId: string, nameOrId: string): Promise<Label | null> {
	const [row] = await db
		.select()
		.from(labels)
		.where(and(eq(labels.mailboxId, mailboxId), or(eq(labels.id, nameOrId), eq(labels.nameKey, labelNameKey(nameOrId)))))
		.limit(1);
	return row ? toLabel(row) : null;
}

/** The labels on one message, ordered by name. */
export async function labelsForMessage(db: AppDatabase, messageId: string): Promise<Label[]> {
	const rows = await db
		.select({ id: labels.id, name: labels.name, color: labels.color, createdAt: labels.createdAt })
		.from(messageLabels)
		.innerJoin(labels, eq(messageLabels.labelId, labels.id))
		.where(eq(messageLabels.messageId, messageId))
		.orderBy(asc(labels.nameKey), asc(labels.id));
	return rows.map(toLabel);
}

/** Labels for many messages at once, keyed by message id (list rows). */
export async function labelsForMessages(db: AppDatabase, messageIds: string[]): Promise<Map<string, Label[]>> {
	const result = new Map<string, Label[]>();
	if (messageIds.length === 0) return result;
	const rows = await db
		.select({ messageId: messageLabels.messageId, id: labels.id, name: labels.name, color: labels.color, createdAt: labels.createdAt })
		.from(messageLabels)
		.innerJoin(labels, eq(messageLabels.labelId, labels.id))
		.where(inArray(messageLabels.messageId, messageIds))
		.orderBy(asc(labels.nameKey), asc(labels.id));
	for (const row of rows) {
		const list = result.get(row.messageId) ?? [];
		list.push(toLabel(row));
		result.set(row.messageId, list);
	}
	return result;
}

/** Attaches a label to a message of the same mailbox; idempotent. Answers the message's labels afterward. */
export async function addMessageLabel(db: AppDatabase, mailboxId: string, messageId: string, labelId: string): Promise<MessageLabelsResult> {
	const [message] = await db.select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, messageId)).limit(1);
	if (message?.mailboxId !== mailboxId) return { ok: false, error: "not_found" };
	const [label] = await db.select({ id: labels.id }).from(labels).where(and(eq(labels.id, labelId), eq(labels.mailboxId, mailboxId))).limit(1);
	if (!label) return { ok: false, error: "not_found" };
	await db.insert(messageLabels).values({ id: newId("mlabel"), messageId, labelId }).onConflictDoNothing();
	return { ok: true, labels: await labelsForMessage(db, messageId) };
}

/** Detaches a label from a message; detaching one that is not attached is a no-op. */
export async function removeMessageLabel(db: AppDatabase, mailboxId: string, messageId: string, labelId: string): Promise<MessageLabelsResult> {
	const [message] = await db.select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, messageId)).limit(1);
	if (message?.mailboxId !== mailboxId) return { ok: false, error: "not_found" };
	await db.delete(messageLabels).where(and(eq(messageLabels.messageId, messageId), eq(messageLabels.labelId, labelId)));
	return { ok: true, labels: await labelsForMessage(db, messageId) };
}

function toLabel(row: { id: string; name: string; color: string | null; createdAt: Date }): Label {
	return { id: row.id, name: row.name, color: row.color ?? null, createdAt: row.createdAt.toISOString() };
}
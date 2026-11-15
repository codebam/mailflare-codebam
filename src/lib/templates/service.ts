import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mailboxTemplates } from "@/db/schema";
import { newId } from "@/lib/ids";
import { MAX_TEMPLATES, MAX_TEMPLATE_BODY_LENGTH, MAX_TEMPLATE_NAME_LENGTH, MAX_TEMPLATE_SUBJECT_LENGTH } from "./template-utils";
import type { MailboxTemplate, TemplateResult } from "./types";

/**
 * Per-mailbox composer snippets. Operator-authored content: bounded values
 * are rejected, never clipped. Templates never send mail.
 */

export async function listTemplates(db: AppDatabase, mailboxId: string): Promise<MailboxTemplate[]> {
	const rows = await db.select().from(mailboxTemplates).where(eq(mailboxTemplates.mailboxId, mailboxId)).orderBy(asc(mailboxTemplates.name), asc(mailboxTemplates.id));
	return rows.map(toTemplate);
}

export async function createTemplate(db: AppDatabase, mailboxId: string, input: { name: string; subject?: string | null; body: string }): Promise<TemplateResult> {
	const invalid = validateTemplate(input);
	if (invalid) return { ok: false, error: invalid };
	const existing = await listTemplates(db, mailboxId);
	if (existing.length >= MAX_TEMPLATES) return { ok: false, error: "limit_reached" };
	const id = newId("tmpl");
	await db.insert(mailboxTemplates).values({
		id,
		mailboxId,
		name: input.name.trim(),
		subject: (input.subject ?? "").trim(),
		body: input.body,
	});
	const [row] = await db.select().from(mailboxTemplates).where(eq(mailboxTemplates.id, id)).limit(1);
	return row ? { ok: true, template: toTemplate(row) } : { ok: false, error: "not_found" };
}

export async function updateTemplate(
	db: AppDatabase,
	mailboxId: string,
	templateId: string,
	input: { name?: string; subject?: string | null; body?: string },
): Promise<TemplateResult> {
	const [row] = await db.select().from(mailboxTemplates).where(and(eq(mailboxTemplates.id, templateId), eq(mailboxTemplates.mailboxId, mailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	const merged = {
		name: input.name ?? row.name,
		subject: input.subject !== undefined ? input.subject : row.subject,
		body: input.body ?? row.body,
	};
	const invalid = validateTemplate(merged);
	if (invalid) return { ok: false, error: invalid };
	await db.update(mailboxTemplates).set({
		name: merged.name.trim(),
		subject: (merged.subject ?? "").trim(),
		body: merged.body,
		updatedAt: new Date(),
	}).where(eq(mailboxTemplates.id, templateId));
	const [updated] = await db.select().from(mailboxTemplates).where(eq(mailboxTemplates.id, templateId)).limit(1);
	return updated ? { ok: true, template: toTemplate(updated) } : { ok: false, error: "not_found" };
}

export async function deleteTemplate(db: AppDatabase, mailboxId: string, templateId: string): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
	const [row] = await db.select({ id: mailboxTemplates.id }).from(mailboxTemplates).where(and(eq(mailboxTemplates.id, templateId), eq(mailboxTemplates.mailboxId, mailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	await db.delete(mailboxTemplates).where(eq(mailboxTemplates.id, templateId));
	return { ok: true };
}

function validateTemplate(input: { name: string; subject?: string | null; body: string }): "invalid_name" | "invalid_subject" | "invalid_body" | null {
	const name = input.name.trim();
	if (!name || name.length > MAX_TEMPLATE_NAME_LENGTH) return "invalid_name";
	const subject = (input.subject ?? "").trim();
	if (subject.length > MAX_TEMPLATE_SUBJECT_LENGTH) return "invalid_subject";
	if (!input.body || input.body.length > MAX_TEMPLATE_BODY_LENGTH) return "invalid_body";
	return null;
}

function toTemplate(row: typeof mailboxTemplates.$inferSelect): MailboxTemplate {
	return {
		id: row.id,
		name: row.name,
		subject: row.subject,
		body: row.body,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
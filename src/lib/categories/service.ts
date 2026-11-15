import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { categories } from "@/db/schema";
import { newId } from "@/lib/ids";
import { GLOBAL_CATEGORY_SCOPE, MAX_CATEGORIES, MAX_CATEGORY_NAME_LENGTH, categoryNameKey } from "./category-utils";
import type { Category, CategoryResult } from "./types";

/**
 * Category definitions: instance-wide (scope "") plus per-mailbox. Messages
 * carry the category id in messages.category; rules and the classifier stamp
 * it. Deleting a definition leaves existing stamps untouched.
 */

/** The mailbox's own categories plus the instance-wide ones, ordered by name. */
export async function listCategories(db: AppDatabase, mailboxId: string): Promise<Category[]> {
	const rows = await db.select().from(categories).where(inArray(categories.mailboxId, [mailboxId, GLOBAL_CATEGORY_SCOPE])).orderBy(asc(categories.nameKey), asc(categories.id));
	return rows.map(toCategory);
}

export async function createCategory(db: AppDatabase, scopeMailboxId: string, input: { name: string; color?: string | null }): Promise<CategoryResult> {
	const name = input.name.trim().replace(/\s+/g, " ");
	if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) return { ok: false, error: "invalid_name" };
	const color = input.color ?? null;
	if (color !== null && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) return { ok: false, error: "invalid_color" };
	const [taken] = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.mailboxId, scopeMailboxId), eq(categories.nameKey, categoryNameKey(name)))).limit(1);
	if (taken) return { ok: false, error: "name_taken" };
	const existing = await db.select({ id: categories.id }).from(categories).where(eq(categories.mailboxId, scopeMailboxId));
	if (existing.length >= MAX_CATEGORIES) return { ok: false, error: "limit_reached" };
	const id = newId("cat");
	await db.insert(categories).values({ id, mailboxId: scopeMailboxId, name, nameKey: categoryNameKey(name), color });
	const [row] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
	return row ? { ok: true, category: toCategory(row) } : { ok: false, error: "not_found" };
}

export async function updateCategory(db: AppDatabase, scopeMailboxId: string, categoryId: string, input: { name?: string; color?: string | null }): Promise<CategoryResult> {
	const [row] = await db.select().from(categories).where(and(eq(categories.id, categoryId), eq(categories.mailboxId, scopeMailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	const set: { name?: string; nameKey?: string; color?: string | null } = {};
	if (input.name !== undefined) {
		const name = input.name.trim().replace(/\s+/g, " ");
		if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) return { ok: false, error: "invalid_name" };
		const key = categoryNameKey(name);
		if (key !== row.nameKey) {
			const [taken] = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.mailboxId, scopeMailboxId), eq(categories.nameKey, key))).limit(1);
			if (taken) return { ok: false, error: "name_taken" };
		}
		set.name = name;
		set.nameKey = key;
	}
	if (input.color !== undefined) {
		if (input.color !== null && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input.color)) return { ok: false, error: "invalid_color" };
		set.color = input.color;
	}
	if (Object.keys(set).length > 0) await db.update(categories).set(set).where(eq(categories.id, categoryId));
	const [updated] = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
	return updated ? { ok: true, category: toCategory(updated) } : { ok: false, error: "not_found" };
}

export async function deleteCategory(db: AppDatabase, scopeMailboxId: string, categoryId: string): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
	const [row] = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, categoryId), eq(categories.mailboxId, scopeMailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	await db.delete(categories).where(eq(categories.id, categoryId));
	return { ok: true };
}

function toCategory(row: typeof categories.$inferSelect): Category {
	return {
		id: row.id,
		name: row.name,
		color: row.color ?? null,
		global: row.mailboxId === GLOBAL_CATEGORY_SCOPE,
		createdAt: row.createdAt.toISOString(),
	};
}
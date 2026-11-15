import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { savedSearches } from "@/db/schema";
import { newId } from "@/lib/ids";
import { MAX_SAVED_SEARCHES, MAX_SAVED_SEARCH_NAME_LENGTH, MAX_SAVED_SEARCH_QUERY_LENGTH } from "./search-utils";
import type { SavedSearch, SavedSearchResult } from "./types";

/** Named searches for the sidebar; newest first. Names need not be unique. */

export async function listSavedSearches(db: AppDatabase, mailboxId: string): Promise<SavedSearch[]> {
	const rows = await db.select().from(savedSearches).where(eq(savedSearches.mailboxId, mailboxId)).orderBy(desc(savedSearches.createdAt), desc(savedSearches.id));
	return rows.map(toSearch);
}

export async function createSavedSearch(db: AppDatabase, mailboxId: string, input: { name: string; query: string }): Promise<SavedSearchResult> {
	const invalid = validateSearch(input);
	if (invalid) return { ok: false, error: invalid };
	const existing = await listSavedSearches(db, mailboxId);
	if (existing.length >= MAX_SAVED_SEARCHES) return { ok: false, error: "limit_reached" };
	const id = newId("search");
	await db.insert(savedSearches).values({ id, mailboxId, name: input.name.trim(), query: input.query.trim() });
	const [row] = await db.select().from(savedSearches).where(eq(savedSearches.id, id)).limit(1);
	return row ? { ok: true, search: toSearch(row) } : { ok: false, error: "not_found" };
}

export async function updateSavedSearch(db: AppDatabase, mailboxId: string, searchId: string, input: { name?: string; query?: string }): Promise<SavedSearchResult> {
	const [row] = await db.select().from(savedSearches).where(and(eq(savedSearches.id, searchId), eq(savedSearches.mailboxId, mailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	const merged = { name: input.name ?? row.name, query: input.query ?? row.query };
	const invalid = validateSearch(merged);
	if (invalid) return { ok: false, error: invalid };
	await db.update(savedSearches).set({ name: merged.name.trim(), query: merged.query.trim() }).where(eq(savedSearches.id, searchId));
	const [updated] = await db.select().from(savedSearches).where(eq(savedSearches.id, searchId)).limit(1);
	return updated ? { ok: true, search: toSearch(updated) } : { ok: false, error: "not_found" };
}

export async function deleteSavedSearch(db: AppDatabase, mailboxId: string, searchId: string): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
	const [row] = await db.select({ id: savedSearches.id }).from(savedSearches).where(and(eq(savedSearches.id, searchId), eq(savedSearches.mailboxId, mailboxId))).limit(1);
	if (!row) return { ok: false, error: "not_found" };
	await db.delete(savedSearches).where(eq(savedSearches.id, searchId));
	return { ok: true };
}

function validateSearch(input: { name: string; query: string }): "invalid_name" | "invalid_query" | null {
	const name = input.name.trim();
	if (!name || name.length > MAX_SAVED_SEARCH_NAME_LENGTH) return "invalid_name";
	const query = input.query.trim();
	if (!query || query.length > MAX_SAVED_SEARCH_QUERY_LENGTH) return "invalid_query";
	return null;
}

function toSearch(row: typeof savedSearches.$inferSelect): SavedSearch {
	return { id: row.id, name: row.name, query: row.query, createdAt: row.createdAt.toISOString() };
}
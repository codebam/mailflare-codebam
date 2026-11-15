import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { createSavedSearch, listSavedSearches } from "@/lib/saved-searches/service";
import { loadMailbox, migrationRequired } from "../utils/mailbox";
import { searchError } from "./utils";

/** Lists the mailbox's saved searches, newest first: `?mailboxId=`. */
export async function GET(request: Request) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ searches: await listSavedSearches(loaded.db, loaded.mailboxId) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ searches: [] });
		throw error;
	}
}

/** Saves a named search: `{ mailboxId, name, query }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; name?: unknown; query?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await createSavedSearch(loaded.db, loaded.mailboxId, {
			name: typeof body?.name === "string" ? body.name : "",
			query: typeof body?.query === "string" ? body.query : "",
		});
		return result.ok ? NextResponse.json({ search: result.search }, { status: 201 }) : searchError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
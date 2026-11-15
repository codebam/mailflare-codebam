import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { deleteSavedSearch, updateSavedSearch } from "@/lib/saved-searches/service";
import { loadMailbox, migrationRequired } from "../../utils/mailbox";
import { searchError } from "../utils";

type RouteContext = { params: Promise<{ searchId: string }> };

/** Updates a saved search; omitted fields keep their stored value. */
export async function PATCH(request: Request, context: RouteContext) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; name?: unknown; query?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await updateSavedSearch(loaded.db, loaded.mailboxId, (await context.params).searchId, {
			name: typeof body?.name === "string" ? body.name : undefined,
			query: typeof body?.query === "string" ? body.query : undefined,
		});
		return result.ok ? NextResponse.json({ search: result.search }) : searchError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

/** Deletes a saved search: `?mailboxId=`. */
export async function DELETE(request: Request, context: RouteContext) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"), true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await deleteSavedSearch(loaded.db, loaded.mailboxId, (await context.params).searchId);
		return result.ok ? NextResponse.json({ deleted: true }) : searchError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
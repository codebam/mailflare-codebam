import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { deleteCategory, updateCategory } from "@/lib/categories/service";
import { loadMailbox, migrationRequired } from "../../utils/mailbox";
import { categoryError } from "../utils";

type RouteContext = { params: Promise<{ categoryId: string }> };

/** Renames/recolors a mailbox category; null color clears it. */
export async function PATCH(request: Request, context: RouteContext) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; name?: unknown; color?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await updateCategory(loaded.db, loaded.mailboxId, (await context.params).categoryId, {
			name: typeof body?.name === "string" ? body.name : undefined,
			color: body?.color === null ? null : typeof body?.color === "string" ? body.color : undefined,
		});
		return result.ok ? NextResponse.json({ category: result.category }) : categoryError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

/** Deletes a category definition; existing message stamps are untouched. */
export async function DELETE(request: Request, context: RouteContext) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"), true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await deleteCategory(loaded.db, loaded.mailboxId, (await context.params).categoryId);
		return result.ok ? NextResponse.json({ deleted: true }) : categoryError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
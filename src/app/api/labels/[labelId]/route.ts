import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { deleteLabel, updateLabel } from "@/lib/labels/service";
import { labelErrorResponse, loadLabelMailbox, migrationRequired } from "../utils";

type RouteContext = { params: Promise<{ labelId: string }> };

/** Renames and/or recolors a label: `{ mailboxId, name?, color? }`; null color clears it. */
export async function PATCH(request: Request, context: RouteContext) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; name?: unknown; color?: unknown } | null;
	const loaded = await loadLabelMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	const input: { name?: string; color?: string | null } = {};
	if (typeof body?.name === "string") input.name = body.name;
	if (body?.color === null || typeof body?.color === "string") input.color = body.color;
	try {
		const result = await updateLabel(loaded.db, loaded.mailboxId, (await context.params).labelId, input);
		return result.ok ? NextResponse.json({ label: result.label }) : labelErrorResponse(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

/** Deletes a label and detaches it from every message: `?mailboxId=`. */
export async function DELETE(request: Request, context: RouteContext) {
	const loaded = await loadLabelMailbox(request, new URL(request.url).searchParams.get("mailboxId"), true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await deleteLabel(loaded.db, loaded.mailboxId, (await context.params).labelId);
		return result.ok ? NextResponse.json({ deleted: true }) : labelErrorResponse(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
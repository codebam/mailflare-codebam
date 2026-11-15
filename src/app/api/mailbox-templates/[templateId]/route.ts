import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { deleteTemplate, updateTemplate } from "@/lib/templates/service";
import { loadMailbox, migrationRequired } from "../../utils/mailbox";
import { templateError } from "../utils";

type RouteContext = { params: Promise<{ templateId: string }> };

/** Updates a template; omitted fields keep their value, null subject clears it. */
export async function PATCH(request: Request, context: RouteContext) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; name?: unknown; subject?: unknown; body?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await updateTemplate(loaded.db, loaded.mailboxId, (await context.params).templateId, {
			name: typeof body?.name === "string" ? body.name : undefined,
			subject: body?.subject === null ? null : typeof body?.subject === "string" ? body.subject : undefined,
			body: typeof body?.body === "string" ? body.body : undefined,
		});
		return result.ok ? NextResponse.json({ template: result.template }) : templateError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

/** Deletes a template: `?mailboxId=`. */
export async function DELETE(request: Request, context: RouteContext) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"), true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await deleteTemplate(loaded.db, loaded.mailboxId, (await context.params).templateId);
		return result.ok ? NextResponse.json({ deleted: true }) : templateError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
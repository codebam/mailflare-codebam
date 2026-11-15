import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { createTemplate, listTemplates } from "@/lib/templates/service";
import { loadMailbox, migrationRequired } from "../utils/mailbox";
import { templateError } from "./utils";

/** Lists the mailbox's templates: `?mailboxId=`. */
export async function GET(request: Request) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ templates: await listTemplates(loaded.db, loaded.mailboxId) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ templates: [] });
		throw error;
	}
}

/** Creates a template: `{ mailboxId, name, subject?, body }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; name?: unknown; subject?: unknown; body?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await createTemplate(loaded.db, loaded.mailboxId, {
			name: typeof body?.name === "string" ? body.name : "",
			subject: body?.subject === null ? null : typeof body?.subject === "string" ? body.subject : undefined,
			body: typeof body?.body === "string" ? body.body : "",
		});
		return result.ok ? NextResponse.json({ template: result.template }, { status: 201 }) : templateError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
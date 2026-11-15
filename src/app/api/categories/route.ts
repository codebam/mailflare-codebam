import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { createCategory, listCategories } from "@/lib/categories/service";
import { loadMailbox, migrationRequired } from "../utils/mailbox";
import { categoryError } from "./utils";

/** The mailbox's categories plus instance-wide ones: `?mailboxId=`. */
export async function GET(request: Request) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ categories: await listCategories(loaded.db, loaded.mailboxId) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ categories: [] });
		throw error;
	}
}

/** Creates a mailbox category: `{ mailboxId, name, color? }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; name?: unknown; color?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await createCategory(loaded.db, loaded.mailboxId, {
			name: typeof body?.name === "string" ? body.name : "",
			color: body?.color === null ? null : typeof body?.color === "string" ? body.color : undefined,
		});
		return result.ok ? NextResponse.json({ category: result.category }, { status: 201 }) : categoryError(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { createLabel, listLabels } from "@/lib/labels/service";
import { labelErrorResponse, loadLabelMailbox, migrationRequired } from "./utils";

/** Lists the labels of `?mailboxId=`, ordered by name. */
export async function GET(request: Request) {
	const loaded = await loadLabelMailbox(request, new URL(request.url).searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ labels: await listLabels(loaded.db, loaded.mailboxId) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ labels: [] });
		throw error;
	}
}

/** Creates a label: `{ mailboxId, name, color? }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; name?: unknown; color?: unknown } | null;
	const loaded = await loadLabelMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	const name = typeof body?.name === "string" ? body.name : "";
	const color = body?.color === null ? null : typeof body?.color === "string" ? body.color : undefined;
	try {
		const result = await createLabel(loaded.db, loaded.mailboxId, { name, color });
		return result.ok ? NextResponse.json({ label: result.label }, { status: 201 }) : labelErrorResponse(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
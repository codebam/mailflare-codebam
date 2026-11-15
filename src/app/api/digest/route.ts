import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { getDigest } from "@/lib/digest/service";
import { loadMailbox } from "../utils/mailbox";

/** The trailing-24-hour brief: `?mailboxId=`. Computed on demand; nothing stored or sent. */
export async function GET(request: Request) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json(await getDigest(loaded.db, loaded.mailboxId));
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
		throw error;
	}
}
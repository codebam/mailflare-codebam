import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { previewRule } from "@/lib/rules/service";
import { loadMailbox, migrationRequired } from "../../utils/mailbox";

/** Dry-run a rule draft against stored mail; writes nothing: `{ mailboxId, name?, match }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loaded = await loadMailbox(request, body?.mailboxId);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await previewRule(loaded.db, loaded.mailboxId, {
			name: typeof body?.name === "string" ? body.name : undefined,
			match: body?.match as never,
		});
		return NextResponse.json(result);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
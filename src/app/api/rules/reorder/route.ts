import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { reorderRules } from "@/lib/rules/service";
import { loadMailbox, migrationRequired } from "../../utils/mailbox";

/** Rewrite priorities to follow `ruleIds`: `{ mailboxId, ruleIds }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	const ruleIds = Array.isArray(body?.ruleIds) ? body.ruleIds.filter((id): id is string => typeof id === "string") : [];
	try {
		return NextResponse.json({ rules: await reorderRules(loaded.db, loaded.mailboxId, ruleIds) });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
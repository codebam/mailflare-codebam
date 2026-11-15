import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { RuleValidationError } from "@/lib/rules/engine";
import { applyRule } from "@/lib/rules/service";
import { loadMailbox, migrationRequired } from "../../../utils/mailbox";

type RouteContext = { params: Promise<{ ruleId: string }> };

/** Retroactively apply a rule's local actions, one bounded batch: `{ mailboxId, limit? }`. */
export async function POST(request: Request, context: RouteContext) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const result = await applyRule(loaded.db, loaded.mailboxId, (await context.params).ruleId, typeof body?.limit === "number" ? body.limit : undefined);
		return NextResponse.json(result);
	} catch (error) {
		if (error instanceof RuleValidationError) {
			return NextResponse.json({ error: error.message }, { status: error.message === "Rule not found" ? 404 : 400 });
		}
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
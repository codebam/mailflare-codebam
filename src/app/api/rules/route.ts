import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { RuleValidationError } from "@/lib/rules/engine";
import { createRule, listRules } from "@/lib/rules/service";
import { loadMailbox, migrationRequired } from "../utils/mailbox";

/** Lists the mailbox's rules in evaluation order: `?mailboxId=`. */
export async function GET(request: Request) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ rules: await listRules(loaded.db, loaded.mailboxId) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ rules: [] });
		throw error;
	}
}

/** Creates a rule (operator path: outbound actions allowed): `{ mailboxId, name, match, actions, enabled?, priority? }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const rule = await createRule(loaded.db, loaded.mailboxId, {
			name: typeof body?.name === "string" ? body.name : "",
			enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
			priority: typeof body?.priority === "number" ? body.priority : undefined,
			match: body?.match as never,
			actions: body?.actions as never,
		});
		return NextResponse.json({ rule }, { status: 201 });
	} catch (error) {
		if (error instanceof RuleValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
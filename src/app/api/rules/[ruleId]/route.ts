import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { RuleValidationError } from "@/lib/rules/engine";
import { deleteRule, updateRule } from "@/lib/rules/service";
import { loadMailbox, migrationRequired } from "../../utils/mailbox";

type RouteContext = { params: Promise<{ ruleId: string }> };

/** Updates a rule; omitted fields keep their stored value. */
export async function PATCH(request: Request, context: RouteContext) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	try {
		const rule = await updateRule(loaded.db, loaded.mailboxId, (await context.params).ruleId, {
			name: typeof body?.name === "string" ? body.name : undefined,
			enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
			priority: typeof body?.priority === "number" ? body.priority : undefined,
			match: body?.match as never,
			actions: body?.actions as never,
		});
		return NextResponse.json({ rule });
	} catch (error) {
		if (error instanceof RuleValidationError) {
			return NextResponse.json({ error: error.message }, { status: error.message === "Rule not found" ? 404 : 400 });
		}
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

/** Deletes a rule: `?mailboxId=`. No mail is changed. */
export async function DELETE(request: Request, context: RouteContext) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"), true);
	if ("error" in loaded) return loaded.error;
	try {
		const deleted = await deleteRule(loaded.db, loaded.mailboxId, (await context.params).ruleId);
		return deleted ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: "Rule not found" }, { status: 404 });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
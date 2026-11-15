import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { addMessageLabel, labelsForMessage, removeMessageLabel, resolveLabel } from "@/lib/labels/service";
import { labelErrorResponse, loadLabelMailbox, migrationRequired } from "../../../labels/utils";

type RouteContext = { params: Promise<{ messageId: string }> };

/** The message's mailbox, when the signed-in user may read it. */
async function loadMessageMailbox(request: Request, messageId: string) {
	const [message] = await getDb(getEnv()).select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return { error: NextResponse.json({ error: "Message not found" }, { status: 404 }) };
	return loadLabelMailbox(request, message.mailboxId);
}

/** The label named by `label` (name or id) in the message's mailbox. */
async function resolveBodyLabel(request: Request, messageId: string) {
	const body = (await request.json().catch(() => null)) as { label?: unknown; labelId?: unknown } | null;
	const nameOrId = typeof body?.label === "string" ? body.label : typeof body?.labelId === "string" ? body.labelId : "";
	if (!nameOrId) return { error: NextResponse.json({ error: "label is required" }, { status: 400 }) };
	const loaded = await loadMessageMailbox(request, messageId);
	if ("error" in loaded) return loaded;
	const label = await resolveLabel(loaded.db, loaded.mailboxId, nameOrId);
	if (!label) return { error: NextResponse.json({ error: "Label not found" }, { status: 404 }) };
	return { ...loaded, label };
}

/** The labels on this message. */
export async function GET(request: Request, context: RouteContext) {
	const loaded = await loadMessageMailbox(request, (await context.params).messageId);
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ labels: await labelsForMessage(loaded.db, (await context.params).messageId) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ labels: [] });
		throw error;
	}
}

/** Attaches a label: `{ label }` by name or id. Idempotent; answers the message's labels. */
export async function POST(request: Request, context: RouteContext) {
	const messageId = (await context.params).messageId;
	const resolved = await resolveBodyLabel(request, messageId);
	if ("error" in resolved) return resolved.error;
	if (!resolved.canManage) return NextResponse.json({ error: "You cannot manage labels in this mailbox" }, { status: 403 });
	try {
		const result = await addMessageLabel(resolved.db, resolved.mailboxId, messageId, resolved.label.id);
		return result.ok ? NextResponse.json({ labels: result.labels }) : labelErrorResponse(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

/** Detaches a label: `{ label }` by name or id. A label that is not attached is a no-op. */
export async function DELETE(request: Request, context: RouteContext) {
	const messageId = (await context.params).messageId;
	const resolved = await resolveBodyLabel(request, messageId);
	if ("error" in resolved) return resolved.error;
	if (!resolved.canManage) return NextResponse.json({ error: "You cannot manage labels in this mailbox" }, { status: 403 });
	try {
		const result = await removeMessageLabel(resolved.db, resolved.mailboxId, messageId, resolved.label.id);
		return result.ok ? NextResponse.json({ labels: result.labels }) : labelErrorResponse(result.error);
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
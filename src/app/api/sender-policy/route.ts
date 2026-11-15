import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";
import { listSenderPolicies, removeSenderPolicy, setSenderPolicy } from "@/lib/sender-policy/service";
import { isSenderPolicy } from "@/lib/sender-policy/sender-policy-utils";
import { loadMailbox, migrationRequired } from "../utils/mailbox";

/** Lists sender allow/block entries: `?mailboxId=`. */
export async function GET(request: Request) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	try {
		return NextResponse.json({ entries: await listSenderPolicies(loaded.db, loaded.mailboxId) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ entries: [] });
		throw error;
	}
}

/** Creates or replaces an entry: `{ mailboxId, address, policy }`. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { mailboxId?: unknown; address?: unknown; policy?: unknown } | null;
	const loaded = await loadMailbox(request, body?.mailboxId, true);
	if ("error" in loaded) return loaded.error;
	if (typeof body?.address !== "string" || !isSenderPolicy(body?.policy)) {
		return NextResponse.json({ error: "address and policy (allow|block) are required" }, { status: 400 });
	}
	try {
		const entry = await setSenderPolicy(loaded.db, loaded.mailboxId, body.address, body.policy);
		return NextResponse.json({ entry }, { status: 201 });
	} catch (error) {
		if (error instanceof Error && /valid sender email/.test(error.message)) return NextResponse.json({ error: error.message }, { status: 400 });
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

/** Removes an entry: `?mailboxId=&address=`. */
export async function DELETE(request: Request) {
	const url = new URL(request.url);
	const loaded = await loadMailbox(request, url.searchParams.get("mailboxId"), true);
	if ("error" in loaded) return loaded.error;
	const address = url.searchParams.get("address") ?? "";
	try {
		const removed = await removeSenderPolicy(loaded.db, loaded.mailboxId, address);
		return removed ? NextResponse.json({ removed: true }) : NextResponse.json({ error: "Sender policy entry not found" }, { status: 404 });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}
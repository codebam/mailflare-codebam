import { NextResponse } from "next/server";
import { getMailboxStorage } from "@/lib/storage/service";
import { loadMailbox } from "../utils/mailbox";

/** Per-mailbox storage footprint: `?mailboxId=`. Read-only. */
export async function GET(request: Request) {
	const loaded = await loadMailbox(request, new URL(request.url).searchParams.get("mailboxId"));
	if ("error" in loaded) return loaded.error;
	return NextResponse.json(await getMailboxStorage(loaded.db, loaded.mailboxId));
}
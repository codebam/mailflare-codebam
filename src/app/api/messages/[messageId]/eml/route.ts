import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { exportEmail } from "@/lib/eml-export/service";
import { loadMailbox } from "../../../utils/mailbox";

type RouteContext = { params: Promise<{ messageId: string }> };

/** One message as a reconstructed EML block: `{ eml }`. Read-only. */
export async function GET(request: Request, context: RouteContext) {
	const messageId = (await context.params).messageId;
	const [message] = await getDb(getEnv()).select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	const loaded = await loadMailbox(request, message.mailboxId);
	if ("error" in loaded) return loaded.error;
	const result = await exportEmail(loaded.db, loaded.mailboxId, messageId);
	if (!result) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	return NextResponse.json({ emailId: messageId, eml: result.eml });
}
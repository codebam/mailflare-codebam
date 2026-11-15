import { NextResponse } from "next/server";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { LabelError } from "@/lib/labels/types";

export type LoadedLabelMailbox = {
	user: SessionUser;
	db: AppDatabase;
	mailboxId: string;
	canManage: boolean;
};

/** The signed-in user and a mailbox they can read; `needManage` also requires label-write access. */
export async function loadLabelMailbox(request: Request, mailboxId: unknown, needManage = false): Promise<LoadedLabelMailbox | { error: NextResponse }> {
	if (typeof mailboxId !== "string" || !mailboxId) return { error: NextResponse.json({ error: "mailboxId is required" }, { status: 400 }) };
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return { error: NextResponse.json({ error: "Mailbox not found" }, { status: 404 }) };
	if (needManage && !access.canManage) return { error: NextResponse.json({ error: "You cannot manage labels in this mailbox" }, { status: 403 }) };
	return { user, db, mailboxId, canManage: access.canManage };
}

export const migrationRequired = () =>
	NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });

export function labelErrorResponse(error: LabelError) {
	switch (error) {
		case "name_taken":
			return NextResponse.json({ error: "A label with that name already exists" }, { status: 409 });
		case "limit_reached":
			return NextResponse.json({ error: "This mailbox has reached the label limit (100)" }, { status: 409 });
		case "invalid_name":
			return NextResponse.json({ error: "Label name must be 1-50 characters" }, { status: 400 });
		case "invalid_color":
			return NextResponse.json({ error: "Color must be a hex token like #f59e0b" }, { status: 400 });
		default:
			return NextResponse.json({ error: "Label not found" }, { status: 404 });
	}
}
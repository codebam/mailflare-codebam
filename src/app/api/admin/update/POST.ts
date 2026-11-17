import { NextResponse } from "next/server";
import { authorizeAdminRequest } from "./utils";
import { isNodeRuntime } from "@/lib/runtime";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

export async function POST(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	if (isNodeRuntime(authorization.env)) {
		return NextResponse.json({ error: "Self-hosted installs update by pulling the new container image and restarting." }, { status: 400 });
	}

	// This fork stacks its own commits on upstream; the update workflow replaces
	// the whole tree and would drop them, so dispatch is refused here as well.
	return NextResponse.json({ error: "The in-app updater is disabled in this fork: it would replace the fork's changes with upstream. Sync by rebasing onto upstream and redeploying." }, { status: 400 });
}
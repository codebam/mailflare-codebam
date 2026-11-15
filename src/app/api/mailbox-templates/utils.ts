import { NextResponse } from "next/server";
import type { TemplateError } from "@/lib/templates/types";

export function templateError(error: TemplateError) {
	switch (error) {
		case "limit_reached":
			return NextResponse.json({ error: "This mailbox has reached the template limit (200)" }, { status: 409 });
		case "invalid_name":
			return NextResponse.json({ error: "Template name must be 1-120 characters" }, { status: 400 });
		case "invalid_subject":
			return NextResponse.json({ error: "Subject must be at most 500 characters" }, { status: 400 });
		case "invalid_body":
			return NextResponse.json({ error: "Body must be 1-100000 characters" }, { status: 400 });
		default:
			return NextResponse.json({ error: "Template not found" }, { status: 404 });
	}
}
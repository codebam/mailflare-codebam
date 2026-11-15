import { NextResponse } from "next/server";
import type { ItemError } from "@/lib/items/types";

export function itemError(error: ItemError) {
	switch (error) {
		case "invalid_title":
			return NextResponse.json({ error: "Title must be 1-500 characters" }, { status: 400 });
		case "invalid_details":
			return NextResponse.json({ error: "Details must be at most 5000 characters" }, { status: 400 });
		case "invalid_kind":
			return NextResponse.json({ error: "kind must be task or deadline" }, { status: 400 });
		case "invalid_status":
			return NextResponse.json({ error: "status must be open, done or dismissed" }, { status: 400 });
		default:
			return NextResponse.json({ error: "Item not found" }, { status: 404 });
	}
}
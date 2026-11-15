import { NextResponse } from "next/server";
import type { SavedSearchError } from "@/lib/saved-searches/types";

export function searchError(error: SavedSearchError) {
	switch (error) {
		case "limit_reached":
			return NextResponse.json({ error: "This mailbox has reached the saved-search limit (50)" }, { status: 409 });
		case "invalid_name":
			return NextResponse.json({ error: "Search name must be 1-120 characters" }, { status: 400 });
		case "invalid_query":
			return NextResponse.json({ error: "Query must be 1-1000 characters" }, { status: 400 });
		default:
			return NextResponse.json({ error: "Saved search not found" }, { status: 404 });
	}
}
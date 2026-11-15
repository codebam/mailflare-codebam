import { NextResponse } from "next/server";
import type { CategoryError } from "@/lib/categories/types";

export function categoryError(error: CategoryError) {
	switch (error) {
		case "name_taken":
			return NextResponse.json({ error: "A category with that name already exists" }, { status: 409 });
		case "limit_reached":
			return NextResponse.json({ error: "This scope has reached the category limit (100)" }, { status: 409 });
		case "invalid_name":
			return NextResponse.json({ error: "Category name must be 1-50 characters" }, { status: 400 });
		case "invalid_color":
			return NextResponse.json({ error: "Color must be a hex token like #f59e0b" }, { status: 400 });
		default:
			return NextResponse.json({ error: "Category not found" }, { status: 404 });
	}
}
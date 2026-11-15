export type SavedSearch = {
	id: string;
	name: string;
	query: string;
	createdAt: string;
};

export type SavedSearchError = "not_found" | "invalid_name" | "invalid_query" | "limit_reached";

export type SavedSearchResult = { ok: true; search: SavedSearch } | { ok: false; error: SavedSearchError };
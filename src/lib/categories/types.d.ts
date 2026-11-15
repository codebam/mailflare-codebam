export type Category = {
	id: string;
	name: string;
	color: string | null;
	global: boolean;
	createdAt: string;
};

export type CategoryError = "not_found" | "invalid_name" | "invalid_color" | "name_taken" | "limit_reached";

export type CategoryResult = { ok: true; category: Category } | { ok: false; error: CategoryError };
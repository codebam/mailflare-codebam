export type Label = {
	id: string;
	name: string;
	color: string | null;
	createdAt: string;
};

export type LabelError = "not_found" | "name_taken" | "limit_reached" | "invalid_name" | "invalid_color";

export type LabelResult = { ok: true; label: Label } | { ok: false; error: LabelError };

export type MessageLabelsResult = { ok: true; labels: Label[] } | { ok: false; error: "not_found" };
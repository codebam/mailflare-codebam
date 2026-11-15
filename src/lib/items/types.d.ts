import type { ItemDueBucket, ItemKind, ItemStatus } from "./item-utils";

export type Item = {
	id: string;
	messageId: string | null;
	kind: ItemKind;
	title: string;
	details: string | null;
	dueAt: string | null;
	status: ItemStatus;
	createdAt: string;
	updatedAt: string;
};

export type ItemError = "not_found" | "invalid_title" | "invalid_details" | "invalid_kind" | "invalid_status";

export type ItemResult = { ok: true; item: Item } | { ok: false; error: ItemError };

export type ItemListFilter = { status?: ItemStatus; due?: ItemDueBucket };
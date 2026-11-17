"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { apiDelete, apiGet, apiPatch, apiPost } from "./automation-api";

export type LabelRow = { id: string; name: string; color: string | null };

/** Shared CRUD panel for labels and categories (same shape, different endpoints). */
export function TagSettings({ kind }: { kind: "labels" | "categories" }) {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const mailboxId = selectedMailbox?.id ?? null;
	const [rows, setRows] = useState<LabelRow[]>([]);
	const [loadedMailbox, setLoadedMailbox] = useState<string | null>();
	const loading = loadedMailbox === undefined || loadedMailbox !== mailboxId;
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<LabelRow | null>(null);
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState("");
	const [color, setColor] = useState("#2563eb");
	const [hasColor, setHasColor] = useState(false);

	const basePath = kind === "labels" ? "/api/labels" : "/api/categories";
	const refresh = useCallback(() => {
		if (!mailboxId) return;
		void apiGet<{ labels?: LabelRow[]; categories?: LabelRow[] }>(`${basePath}?mailboxId=${encodeURIComponent(mailboxId)}`)
			.then((result) => { setRows(result.labels ?? result.categories ?? []); setError(null); })
			.catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load"))
			.finally(() => setLoadedMailbox(mailboxId));
	}, [mailboxId, basePath]);
	useEffect(() => { refresh(); }, [refresh]);

	function openCreate() { setEditing(null); setName(""); setColor("#2563eb"); setHasColor(false); setOpen(true); }
	function openEdit(row: LabelRow) { setEditing(row); setName(row.name); setColor(row.color ?? "#2563eb"); setHasColor(!!row.color); setOpen(true); }

	async function save(event: React.FormEvent) {
		event.preventDefault();
		if (!mailboxId) return;
		setBusy(true);
		setError(null);
		try {
			const payload = { mailboxId, name, color: hasColor ? color : null };
			if (editing) await apiPatch(`${basePath}/${editing.id}`, payload);
			else await apiPost(basePath, payload);
			setOpen(false);
			refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to save");
		} finally { setBusy(false); }
	}

	async function remove(row: LabelRow) {
		if (!mailboxId || !await confirmDestructive(t(`${kind}.deleteConfirm`, { name: row.name }))) return;
		try {
			await apiDelete(`${basePath}/${row.id}?mailboxId=${encodeURIComponent(mailboxId)}`);
			setRows((current) => current.filter((item) => item.id !== row.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to delete");
		}
	}

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4">
			<h1 className="text-2xl md:text-3xl font-medium">{t(`${kind}.title`)}</h1>
			<Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
				<DialogTrigger asChild><Button type="button" onClick={openCreate}><Plus className="h-4 w-4" />{t(`${kind}.new`)}</Button></DialogTrigger>
				<DialogContent>
					<DialogHeader><DialogTitle>{editing ? t(`${kind}.edit`) : t(`${kind}.new`)}</DialogTitle></DialogHeader>
					<form onSubmit={(event) => void save(event)} className="space-y-4">
						<div className="space-y-2"><Label htmlFor="tag-name">{t("common.name")}</Label><Input id="tag-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={50} required /></div>
						<div className="flex items-center gap-3">
							<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hasColor} onChange={(event) => setHasColor(event.target.checked)} />{t(`${kind}.color`)}</label>
							{hasColor && <input type="color" aria-label={t(`${kind}.color`)} value={color} onChange={(event) => setColor(event.target.value)} className="h-8 w-14 cursor-pointer rounded border border-neutral-200" />}
						</div>
						<Button type="submit" disabled={busy || !name.trim()}>{busy ? t("common.saving") : t("common.save")}</Button>
					</form>
					{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
				</DialogContent>
			</Dialog>
		</div>
		<p className="text-sm text-neutral-500">{t(`${kind}.description`)}</p>
		{error && !open && <p role="alert" className="text-sm text-red-600">{error}</p>}
		<section className="space-y-3">
			{loading && <SectionRowSkeleton />}
			{!loading && rows.length === 0 && <p className="text-sm text-neutral-500">{t(`${kind}.empty`)}</p>}
			{!loading && rows.length > 0 && <List>
				{rows.map((row) => <ListRow key={row.id}>
					<div className="flex min-w-0 flex-1 items-center gap-3">
						{row.color && <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: row.color }} aria-hidden="true" />}
						<span className="truncate font-medium">{row.name}</span>
					</div>
					<Button type="button" size="sm" variant="ghost" aria-label={t(`${kind}.edit`)} onClick={() => openEdit(row)}><Pencil className="h-4 w-4" /></Button>
					<Button type="button" size="sm" variant="ghost" aria-label={t("common.delete")} onClick={() => void remove(row)}><Trash2 className="h-4 w-4" /></Button>
				</ListRow>)}
			</List>}
		</section>
	</div>;
}
"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Pencil, Plus, Trash2 } from "@/components/icons";
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

type SavedSearch = { id: string; name: string; query: string };

/** Named searches for the mailbox; copy the query into the search box to run it. */
export function SavedSearchesSettings() {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const mailboxId = selectedMailbox?.id ?? null;
	const [searches, setSearches] = useState<SavedSearch[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<SavedSearch | null>(null);
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState("");
	const [query, setQuery] = useState("");
	const [copiedId, setCopiedId] = useState<string | null>(null);

	const refresh = useCallback(() => {
		if (!mailboxId) return;
		setLoading(true);
		void apiGet<{ searches: SavedSearch[] }>(`/api/saved-searches?mailboxId=${encodeURIComponent(mailboxId)}`)
			.then((result) => { setSearches(result.searches); setError(null); })
			.catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load searches"))
			.finally(() => setLoading(false));
	}, [mailboxId]);
	useEffect(() => { refresh(); }, [refresh]);

	function openCreate() { setEditing(null); setName(""); setQuery(""); setOpen(true); }
	function openEdit(search: SavedSearch) { setEditing(search); setName(search.name); setQuery(search.query); setOpen(true); }

	async function save(event: React.FormEvent) {
		event.preventDefault();
		if (!mailboxId) return;
		setBusy(true);
		setError(null);
		try {
			if (editing) await apiPatch(`/api/saved-searches/${editing.id}`, { mailboxId, name, query });
			else await apiPost("/api/saved-searches", { mailboxId, name, query });
			setOpen(false);
			refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to save search");
		} finally { setBusy(false); }
	}

	async function remove(search: SavedSearch) {
		if (!mailboxId || !await confirmDestructive(t("savedSearches.deleteConfirm", { name: search.name }))) return;
		try {
			await apiDelete(`/api/saved-searches/${search.id}?mailboxId=${encodeURIComponent(mailboxId)}`);
			setSearches((current) => current.filter((item) => item.id !== search.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to delete search");
		}
	}

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4">
			<h1 className="text-2xl md:text-3xl font-medium">{t("savedSearches.title")}</h1>
			<Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
				<DialogTrigger asChild><Button type="button" onClick={openCreate}><Plus className="h-4 w-4" />{t("savedSearches.new")}</Button></DialogTrigger>
				<DialogContent>
					<DialogHeader><DialogTitle>{editing ? t("savedSearches.edit") : t("savedSearches.new")}</DialogTitle></DialogHeader>
					<form onSubmit={(event) => void save(event)} className="space-y-4">
						<div className="space-y-2"><Label htmlFor="search-name">{t("common.name")}</Label><Input id="search-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></div>
						<div className="space-y-2"><Label htmlFor="search-query">{t("savedSearches.query")}</Label><Input id="search-query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={1000} placeholder="subject:invoice is:unread" required /></div>
						<Button type="submit" disabled={busy || !name.trim() || !query.trim()}>{busy ? t("common.saving") : t("common.save")}</Button>
					</form>
					{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
				</DialogContent>
			</Dialog>
		</div>
		<p className="text-sm text-neutral-500">{t("savedSearches.description")}</p>
		{error && !open && <p role="alert" className="text-sm text-red-600">{error}</p>}
		<section className="space-y-3">
			{loading && <SectionRowSkeleton />}
			{!loading && searches.length === 0 && <p className="text-sm text-neutral-500">{t("savedSearches.empty")}</p>}
			{!loading && searches.length > 0 && <List>
				{searches.map((search) => <ListRow key={search.id}>
					<div className="min-w-0 flex-1">
						<span className="font-medium">{search.name}</span>
						<p className="mt-1 truncate font-mono text-xs text-neutral-500">{search.query}</p>
					</div>
					<Button type="button" size="sm" variant="ghost" aria-label={t("common.copy")} onClick={() => void navigator.clipboard.writeText(search.query).then(() => { setCopiedId(search.id); window.setTimeout(() => setCopiedId(null), 1500); })}>{copiedId === search.id ? t("common.copied") : <Copy className="h-4 w-4" />}</Button>
					<Button type="button" size="sm" variant="ghost" aria-label={t("savedSearches.edit")} onClick={() => openEdit(search)}><Pencil className="h-4 w-4" /></Button>
					<Button type="button" size="sm" variant="ghost" aria-label={t("common.delete")} onClick={() => void remove(search)}><Trash2 className="h-4 w-4" /></Button>
				</ListRow>)}
			</List>}
		</section>
	</div>;
}
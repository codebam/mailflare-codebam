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
import { Textarea } from "@/components/ui/textarea";
import { apiDelete, apiGet, apiPatch, apiPost } from "./automation-api";

type Template = { id: string; name: string; subject: string; body: string };

/** Per-mailbox composer snippets. */
export function MailboxTemplatesSettings() {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const mailboxId = selectedMailbox?.id ?? null;
	const [templates, setTemplates] = useState<Template[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<Template | null>(null);
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState("");
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");

	const refresh = useCallback(() => {
		if (!mailboxId) return;
		setLoading(true);
		void apiGet<{ templates: Template[] }>(`/api/mailbox-templates?mailboxId=${encodeURIComponent(mailboxId)}`)
			.then((result) => { setTemplates(result.templates); setError(null); })
			.catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load templates"))
			.finally(() => setLoading(false));
	}, [mailboxId]);
	useEffect(() => { refresh(); }, [refresh]);

	function openCreate() { setEditing(null); setName(""); setSubject(""); setBody(""); setOpen(true); }
	function openEdit(template: Template) { setEditing(template); setName(template.name); setSubject(template.subject); setBody(template.body); setOpen(true); }

	async function save(event: React.FormEvent) {
		event.preventDefault();
		if (!mailboxId) return;
		setBusy(true);
		setError(null);
		try {
			if (editing) await apiPatch(`/api/mailbox-templates/${editing.id}`, { mailboxId, name, subject, body });
			else await apiPost("/api/mailbox-templates", { mailboxId, name, subject, body });
			setOpen(false);
			refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to save template");
		} finally { setBusy(false); }
	}

	async function remove(template: Template) {
		if (!mailboxId || !await confirmDestructive(t("templates.deleteConfirm", { name: template.name }))) return;
		try {
			await apiDelete(`/api/mailbox-templates/${template.id}?mailboxId=${encodeURIComponent(mailboxId)}`);
			setTemplates((current) => current.filter((item) => item.id !== template.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to delete template");
		}
	}

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4">
			<h1 className="text-2xl md:text-3xl font-medium">{t("templates.title")}</h1>
			<Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
				<DialogTrigger asChild><Button type="button" onClick={openCreate}><Plus className="h-4 w-4" />{t("templates.new")}</Button></DialogTrigger>
				<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
					<DialogHeader><DialogTitle>{editing ? t("templates.edit") : t("templates.new")}</DialogTitle></DialogHeader>
					<form onSubmit={(event) => void save(event)} className="space-y-4">
						<div className="space-y-2"><Label htmlFor="template-name">{t("common.name")}</Label><Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></div>
						<div className="space-y-2"><Label htmlFor="template-subject">{t("templates.subject")}</Label><Input id="template-subject" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={500} /></div>
						<div className="space-y-2"><Label htmlFor="template-body">{t("templates.body")}</Label><Textarea id="template-body" value={body} onChange={(event) => setBody(event.target.value)} rows={8} required /></div>
						<Button type="submit" disabled={busy || !name.trim() || !body.trim()}>{busy ? t("common.saving") : t("common.save")}</Button>
					</form>
					{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
				</DialogContent>
			</Dialog>
		</div>
		<p className="text-sm text-neutral-500">{t("templates.description")}</p>
		{error && !open && <p role="alert" className="text-sm text-red-600">{error}</p>}
		<section className="space-y-3">
			{loading && <SectionRowSkeleton />}
			{!loading && templates.length === 0 && <p className="text-sm text-neutral-500">{t("templates.empty")}</p>}
			{!loading && templates.length > 0 && <List>
				{templates.map((template) => <ListRow key={template.id}>
					<div className="min-w-0 flex-1">
						<span className="font-medium">{template.name}</span>
						{template.subject && <p className="mt-1 truncate text-xs text-neutral-500">{template.subject}</p>}
					</div>
					<Button type="button" size="sm" variant="ghost" aria-label={t("templates.edit")} onClick={() => openEdit(template)}><Pencil className="h-4 w-4" /></Button>
					<Button type="button" size="sm" variant="ghost" aria-label={t("common.delete")} onClick={() => void remove(template)}><Trash2 className="h-4 w-4" /></Button>
				</ListRow>)}
			</List>}
		</section>
	</div>;
}
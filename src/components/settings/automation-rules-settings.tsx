"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { Switch } from "@/components/ui/switch";
import { apiDelete, apiGet, apiPatch, apiPost } from "./automation-api";

type RuleConditions = { from_contains?: string; to_contains?: string; subject_contains?: string; body_contains?: string; has_attachment?: boolean; category_equals?: string };
type RuleActions = { move_to_folder?: string; set_category?: string; mark_read?: boolean; mark_unread?: boolean; star?: boolean; unstar?: boolean; discard?: boolean };
type Rule = { id: string; name: string; enabled: boolean; priority: number; match: { mode: "all" | "any"; conditions: RuleConditions }; actions: RuleActions; fired_count: number };
type Folder = { id: string; name: string };

const emptyConditions: RuleConditions = {};
const emptyActions: RuleActions = {};

function summarize(rule: Rule): string {
	const conditions = Object.entries(rule.match.conditions).filter(([, value]) => value !== undefined && value !== "" && value !== false).map(([key, value]) => `${key.replace("_contains", "").replace("_", " ")}: ${value}`);
	const actions = Object.entries(rule.actions).filter(([, value]) => value !== undefined && value !== false).map(([key, value]) => `${key.replace(/_/g, " ")}${typeof value === "string" ? ` → ${value}` : ""}`);
	return `${conditions.join(rule.match.mode === "any" ? " OR " : " AND ") || "(no conditions)"} ⇒ ${actions.join(", ") || "(no actions)"}`;
}

/** Deterministic per-mailbox rules: edit, preview, retroactive apply. */
export function AutomationRulesSettings() {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const mailboxId = selectedMailbox?.id ?? null;
	const [rules, setRules] = useState<Rule[]>([]);
	const [folders, setFolders] = useState<Folder[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<Rule | null>(null);
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState("");
	const [mode, setMode] = useState<"all" | "any">("all");
	const [conditions, setConditions] = useState<RuleConditions>(emptyConditions);
	const [actions, setActions] = useState<RuleActions>(emptyActions);
	const [priority, setPriority] = useState(0);
	const [preview, setPreview] = useState<{ rule: Rule; total: number; scanned: number } | null>(null);
	const [applyResult, setApplyResult] = useState<{ rule: Rule; applied: number } | null>(null);

	const refresh = useCallback(() => {
		if (!mailboxId) return;
		setLoading(true);
		void Promise.all([
			apiGet<{ rules: Rule[] }>(`/api/rules?mailboxId=${encodeURIComponent(mailboxId)}`),
			apiGet<{ folders: Folder[] }>(`/api/folders?mailboxId=${encodeURIComponent(mailboxId)}`),
		]).then(([rulesBody, foldersBody]) => { setRules(rulesBody.rules); setFolders(foldersBody.folders); setError(null); })
			.catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load rules"))
			.finally(() => setLoading(false));
	}, [mailboxId]);
	useEffect(() => { refresh(); }, [refresh]);

	function openCreate() { setEditing(null); setName(""); setMode("all"); setConditions({}); setActions({}); setPriority(rules.length); setOpen(true); }
	function openEdit(rule: Rule) { setEditing(rule); setName(rule.name); setMode(rule.match.mode); setConditions(rule.match.conditions); setActions(rule.actions); setPriority(rule.priority); setOpen(true); }

	async function save(event: React.FormEvent) {
		event.preventDefault();
		if (!mailboxId) return;
		setBusy(true);
		setError(null);
		try {
			const payload = { mailboxId, name, priority, match: { mode, conditions }, actions };
			if (editing) await apiPatch(`/api/rules/${editing.id}`, payload);
			else await apiPost("/api/rules", payload);
			setOpen(false);
			refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to save rule");
		} finally { setBusy(false); }
	}

	async function toggle(rule: Rule) {
		if (!mailboxId) return;
		try {
			await apiPatch(`/api/rules/${rule.id}`, { mailboxId, enabled: !rule.enabled });
			refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to update rule");
		}
	}

	async function remove(rule: Rule) {
		if (!mailboxId || !await confirmDestructive(t("automationRules.deleteConfirm", { name: rule.name }))) return;
		try {
			await apiDelete(`/api/rules/${rule.id}?mailboxId=${encodeURIComponent(mailboxId)}`);
			setRules((current) => current.filter((item) => item.id !== rule.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to delete rule");
		}
	}

	async function runPreview(rule: Rule) {
		if (!mailboxId) return;
		try {
			const result = await apiPost<{ total: number; scanned: number }>("/api/rules/preview", { mailboxId, match: rule.match });
			setPreview({ rule, total: result.total, scanned: result.scanned });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Preview failed");
		}
	}

	async function runApply(rule: Rule) {
		if (!mailboxId) return;
		setBusy(true);
		setError(null);
		try {
			let applied = 0;
			for (;;) {
				const result = await apiPost<{ applied: number; remaining: number }>(`/api/rules/${rule.id}/apply`, { mailboxId });
				applied += result.applied;
				if (result.remaining <= 0) break;
			}
			setApplyResult({ rule, applied });
			refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Apply failed");
		} finally { setBusy(false); }
	}

	const setCondition = (key: keyof RuleConditions, value: string | boolean | undefined) => setConditions((current) => ({ ...current, [key]: value === "" ? undefined : value }));
	const setAction = (key: keyof RuleActions, value: string | boolean | undefined) => setActions((current) => ({ ...current, [key]: value === "" ? undefined : value }));

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4">
			<h1 className="text-2xl md:text-3xl font-medium">{t("automationRules.title")}</h1>
			<Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
				<DialogTrigger asChild><Button type="button" onClick={openCreate}><Plus className="h-4 w-4" />{t("automationRules.new")}</Button></DialogTrigger>
				<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
					<DialogHeader><DialogTitle>{editing ? t("automationRules.edit") : t("automationRules.new")}</DialogTitle></DialogHeader>
					<form onSubmit={(event) => void save(event)} className="space-y-4">
						<div className="space-y-2"><Label htmlFor="rule-name">{t("common.name")}</Label><Input id="rule-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></div>
						<fieldset className="space-y-2 rounded-lg border border-neutral-200 p-3">
							<legend className="px-1 text-sm font-medium">{t("automationRules.conditions")}</legend>
							<div className="flex items-center gap-4 text-sm">
								<label className="flex items-center gap-2"><input type="radio" name="rule-mode" checked={mode === "all"} onChange={() => setMode("all")} />{t("automationRules.matchAll")}</label>
								<label className="flex items-center gap-2"><input type="radio" name="rule-mode" checked={mode === "any"} onChange={() => setMode("any")} />{t("automationRules.matchAny")}</label>
							</div>
							<div className="grid gap-2 sm:grid-cols-2">
								<Input aria-label="from contains" placeholder={t("automationRules.fromContains")} value={conditions.from_contains ?? ""} onChange={(event) => setCondition("from_contains", event.target.value)} />
								<Input aria-label="to contains" placeholder={t("automationRules.toContains")} value={conditions.to_contains ?? ""} onChange={(event) => setCondition("to_contains", event.target.value)} />
								<Input aria-label="subject contains" placeholder={t("automationRules.subjectContains")} value={conditions.subject_contains ?? ""} onChange={(event) => setCondition("subject_contains", event.target.value)} />
								<Input aria-label="body contains" placeholder={t("automationRules.bodyContains")} value={conditions.body_contains ?? ""} onChange={(event) => setCondition("body_contains", event.target.value)} />
								<Input aria-label="category equals" placeholder={t("automationRules.categoryEquals")} value={conditions.category_equals ?? ""} onChange={(event) => setCondition("category_equals", event.target.value)} />
								<label className="flex items-center gap-2 text-sm"><Checkbox checked={conditions.has_attachment === true} onChange={(event) => setCondition("has_attachment", event.target.checked || undefined)} />{t("automationRules.hasAttachment")}</label>
							</div>
						</fieldset>
						<fieldset className="space-y-2 rounded-lg border border-neutral-200 p-3">
							<legend className="px-1 text-sm font-medium">{t("automationRules.actions")}</legend>
							<div className="space-y-2">
								<Label htmlFor="rule-folder">{t("automationRules.moveToFolder")}</Label>
								<select id="rule-folder" className="h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm" value={actions.move_to_folder ?? ""} onChange={(event) => setAction("move_to_folder", event.target.value || undefined)}>
									<option value="">{t("common.none")}</option>
									{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
								</select>
							</div>
							<div className="space-y-2"><Label htmlFor="rule-category">{t("automationRules.setCategory")}</Label><Input id="rule-category" value={actions.set_category ?? ""} onChange={(event) => setAction("set_category", event.target.value || undefined)} /></div>
							<div className="grid grid-cols-2 gap-2 text-sm">
								<label className="flex items-center gap-2"><Checkbox checked={actions.mark_read === true} onChange={(event) => setAction("mark_read", event.target.checked || undefined)} />{t("common.markRead")}</label>
								<label className="flex items-center gap-2"><Checkbox checked={actions.mark_unread === true} onChange={(event) => setAction("mark_unread", event.target.checked || undefined)} />{t("common.markUnread")}</label>
								<label className="flex items-center gap-2"><Checkbox checked={actions.star === true} onChange={(event) => setAction("star", event.target.checked || undefined)} />{t("automationRules.star")}</label>
								<label className="flex items-center gap-2"><Checkbox checked={actions.unstar === true} onChange={(event) => setAction("unstar", event.target.checked || undefined)} />{t("automationRules.unstar")}</label>
								<label className="flex items-center gap-2"><Checkbox checked={actions.discard === true} onChange={(event) => setAction("discard", event.target.checked || undefined)} />{t("automationRules.discard")}</label>
							</div>
						</fieldset>
						<div className="space-y-2"><Label htmlFor="rule-priority">{t("automationRules.priority")}</Label><Input id="rule-priority" type="number" min={0} max={10000} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></div>
						<Button type="submit" disabled={busy || !name.trim()}>{busy ? t("common.saving") : t("common.save")}</Button>
					</form>
					{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
				</DialogContent>
			</Dialog>
		</div>
		<p className="text-sm text-neutral-500">{t("automationRules.description")}</p>
		{error && !open && <p role="alert" className="text-sm text-red-600">{error}</p>}
		{preview && <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">{t("automationRules.previewResult", { name: preview.rule.name, total: preview.total, scanned: preview.scanned })} <Button type="button" size="sm" variant="ghost" onClick={() => setPreview(null)}>{t("common.done")}</Button></p>}
		{applyResult && <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm">{t("automationRules.applyResult", { name: applyResult.rule.name, applied: applyResult.applied })} <Button type="button" size="sm" variant="ghost" onClick={() => setApplyResult(null)}>{t("common.done")}</Button></p>}
		<section className="space-y-3">
			{loading && <SectionRowSkeleton />}
			{!loading && rules.length === 0 && <p className="text-sm text-neutral-500">{t("automationRules.empty")}</p>}
			{!loading && rules.length > 0 && <List>
				{rules.map((rule) => <ListRow key={rule.id} className="flex-wrap">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium">{rule.name}</span>
							<Badge variant="outline">#{rule.priority}</Badge>
							{rule.fired_count > 0 && <Badge variant="secondary">{t("automationRules.fired", { count: rule.fired_count })}</Badge>}
						</div>
						<p className="mt-1 break-words text-xs text-neutral-500">{summarize(rule)}</p>
					</div>
					<div className="flex items-center gap-2">
						<Switch checked={rule.enabled} onCheckedChange={() => void toggle(rule)} aria-label={t("automationRules.enabled")} />
						<Button type="button" size="sm" variant="outline" onClick={() => void runPreview(rule)}>{t("automationRules.preview")}</Button>
						<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void runApply(rule)}>{t("automationRules.apply")}</Button>
						<Button type="button" size="sm" variant="ghost" aria-label={t("automationRules.edit")} onClick={() => openEdit(rule)}><Pencil className="h-4 w-4" /></Button>
						<Button type="button" size="sm" variant="ghost" aria-label={t("common.delete")} onClick={() => void remove(rule)}><Trash2 className="h-4 w-4" /></Button>
					</div>
				</ListRow>)}
			</List>}
		</section>
	</div>;
}
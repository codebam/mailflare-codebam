"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ListChecks, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { List, ListRow } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { apiGet, apiPatch } from "@/components/settings/automation-api";
import { formatUserDate } from "@/lib/time/utils";

type Item = { id: string; messageId: string | null; kind: "task" | "deadline"; title: string; details: string | null; dueAt: string | null; status: "open" | "done" | "dismissed" };
type Filter = "open" | "done" | "dismissed";

/** Tasks and deadlines extracted from mail (or added by agents). */
export function ItemsView() {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const mailboxId = selectedMailbox?.id ?? null;
	const [items, setItems] = useState<Item[]>([]);
	const [filter, setFilter] = useState<Filter>("open");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(() => {
		if (!mailboxId) return;
		setLoading(true);
		void apiGet<{ items: Item[] }>(`/api/items?mailboxId=${encodeURIComponent(mailboxId)}&status=${filter}`)
			.then((result) => { setItems(result.items); setError(null); })
			.catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load items"))
			.finally(() => setLoading(false));
	}, [mailboxId, filter]);
	useEffect(() => { refresh(); }, [refresh]);

	async function setStatus(item: Item, status: Item["status"]) {
		if (!mailboxId) return;
		try {
			await apiPatch(`/api/items/${item.id}`, { mailboxId, status });
			refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to update item");
		}
	}

	const now = Date.now();
	return <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
		<div className="flex items-center gap-3">
			<ListChecks className="h-6 w-6 text-neutral-500" />
			<h1 className="text-2xl md:text-3xl font-medium">{t("items.title")}</h1>
		</div>
		<div className="flex gap-2">
			{(["open", "done", "dismissed"] as Filter[]).map((value) => <Button key={value} type="button" size="sm" variant={filter === value ? "default" : "outline"} onClick={() => setFilter(value)}>{t(`items.filter.${value}`)}</Button>)}
		</div>
		{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
		{loading && <SectionRowSkeleton />}
		{!loading && items.length === 0 && <p className="text-sm text-neutral-500">{t("items.empty")}</p>}
		{!loading && items.length > 0 && <List>
			{items.map((item) => {
				const overdue = item.dueAt && item.status === "open" && new Date(item.dueAt).getTime() < now;
				return <ListRow key={item.id}>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className={`font-medium ${item.status !== "open" ? "text-neutral-400 line-through" : ""}`}>{item.title}</span>
							<Badge variant="outline">{t(`items.kind.${item.kind}`)}</Badge>
							{item.dueAt && <Badge variant={overdue ? "default" : "secondary"} className={overdue ? "bg-red-600 text-white" : undefined}>{formatUserDate(item.dueAt, { dateStyle: "medium" })}</Badge>}
						</div>
						{item.details && <p className="mt-1 text-xs text-neutral-500">{item.details}</p>}
					</div>
					{item.status === "open" ? <div className="flex gap-1">
						<Button type="button" size="sm" variant="ghost" aria-label={t("items.markDone")} onClick={() => void setStatus(item, "done")}><Check className="h-4 w-4" /></Button>
						<Button type="button" size="sm" variant="ghost" aria-label={t("items.dismiss")} onClick={() => void setStatus(item, "dismissed")}><X className="h-4 w-4" /></Button>
					</div> : <Button type="button" size="sm" variant="outline" onClick={() => void setStatus(item, "open")}>{t("items.reopen")}</Button>}
				</ListRow>;
			})}
		</List>}
	</div>;
}
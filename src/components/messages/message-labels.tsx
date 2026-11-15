"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, Tag } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Label = { id: string; name: string; color: string | null; createdAt: string };

const WIDTH = 280;
const GAP = 4;
const MARGIN = 8;

type Placement = { left: number; top?: number; bottom?: number; maxHeight: number };

/**
 * Tag button on a message's action bar. Clicking it opens the mailbox's
 * labels with the ones on this message checked; toggling attaches or
 * detaches, and the footer row creates a new label and attaches it.
 */
export function MessageLabelsButton({ messageId, mailboxId }: { messageId: string; mailboxId: string }) {
	const { t } = useLanguage();
	const [open, setOpen] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [placement, setPlacement] = useState<Placement | null>(null);
	const [labels, setLabels] = useState<Label[]>([]);
	const [attached, setAttached] = useState<Set<string>>(new Set());
	const [newName, setNewName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		try {
			const [mailboxResponse, messageResponse] = await Promise.all([
				fetch(`/api/labels?mailboxId=${encodeURIComponent(mailboxId)}`),
				fetch(`/api/messages/${encodeURIComponent(messageId)}/labels`),
			]);
			if (!mailboxResponse.ok || !messageResponse.ok) throw new Error();
			const mailboxBody = (await mailboxResponse.json()) as { labels: Label[] };
			const messageBody = (await messageResponse.json()) as { labels: Label[] };
			setLabels(mailboxBody.labels);
			setAttached(new Set(messageBody.labels.map((label) => label.id)));
			setLoaded(true);
		} catch {
			setError(t("label.error"));
		}
	}, [mailboxId, messageId, t]);

	const toggleOpen = useCallback(() => {
		setOpen((current) => {
			const next = !current;
			if (next && !loaded) void load();
			return next;
		});
	}, [loaded, load]);

	const close = useCallback(() => setOpen(false), []);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
			close();
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") close();
		}
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, close]);

	useLayoutEffect(() => {
		if (!open) return;
		function place() {
			const rect = triggerRef.current?.getBoundingClientRect();
			if (!rect) return;
			const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
			const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
			const below = window.innerHeight - rect.bottom - GAP - MARGIN;
			const above = rect.top - GAP - MARGIN;
			setPlacement(below >= 240 || below >= above
				? { left, top: rect.bottom + GAP, maxHeight: below }
				: { left, bottom: window.innerHeight - rect.top + GAP, maxHeight: above });
		}
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	async function toggleLabel(label: Label) {
		if (busy) return;
		setBusy(true);
		setError(null);
		const isAttached = attached.has(label.id);
		try {
			const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/labels`, {
				method: isAttached ? "DELETE" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ label: label.id }),
			});
			const body = (await response.json().catch(() => null)) as { labels?: Label[]; error?: string } | null;
			if (!response.ok || !body?.labels) throw new Error(body?.error);
			setAttached(new Set(body.labels.map((item) => item.id)));
		} catch {
			setError(t("label.error"));
		} finally {
			setBusy(false);
		}
	}

	async function createLabel() {
		const name = newName.trim();
		if (!name || busy) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/labels", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId, name }),
			});
			const body = (await response.json().catch(() => null)) as { label?: Label; error?: string } | null;
			if (!response.ok || !body?.label) throw new Error(body?.error);
			setLabels((current) => [...current, body.label!].sort((a, b) => a.name.localeCompare(b.name)));
			setNewName("");
			await toggleLabel(body.label);
		} catch {
			setError(t("label.error"));
		} finally {
			setBusy(false);
		}
	}

	const count = attached.size;
	const panel = open && typeof document !== "undefined"
		? createPortal(
			<div
				ref={panelRef}
				role="dialog"
				aria-label={t("label.title")}
				className="fixed z-[100] flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white text-left text-sm font-normal shadow-lg"
				style={{
					left: placement?.left ?? 0,
					top: placement?.top,
					bottom: placement?.bottom,
					width: Math.min(WIDTH, window.innerWidth - MARGIN * 2),
					maxHeight: placement?.maxHeight,
					visibility: placement ? "visible" : "hidden",
				}}
			>
				<div className="min-h-0 flex-1 overflow-y-auto p-1">
					{!loaded && !error && <p className="px-2 py-1.5 text-xs text-neutral-500">…</p>}
					{loaded && labels.length === 0 && <p className="px-2 py-1.5 text-xs text-neutral-500">{t("label.empty")}</p>}
					{labels.map((label) => (
						<button
							key={label.id}
							type="button"
							disabled={busy}
							onClick={() => void toggleLabel(label)}
							className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-neutral-800 transition-colors hover:bg-neutral-100 disabled:opacity-60"
						>
							<span
								className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", attached.has(label.id) ? "border-blue-600 bg-blue-600 text-white" : "border-neutral-300")}
								aria-hidden="true"
							>
								{attached.has(label.id) && <Check className="h-3 w-3" />}
							</span>
							{label.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} aria-hidden="true" />}
							<span className="truncate">{label.name}</span>
						</button>
					))}
				</div>
				{error && <p role="alert" className="px-3 pb-1 text-xs text-red-600">{error}</p>}
				<form
					className="flex items-center gap-1 border-t border-neutral-200 p-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						void createLabel();
					}}
				>
					<input
						value={newName}
						onChange={(event) => setNewName(event.target.value)}
						placeholder={t("label.newPlaceholder")}
						maxLength={50}
						className="h-8 min-w-0 flex-1 rounded-md border border-neutral-200 px-2 text-xs focus:border-blue-500 focus:outline-none"
						aria-label={t("label.newPlaceholder")}
					/>
					<Button type="submit" variant="ghost" size="sm" className="h-8 w-8 px-0" aria-label={t("label.create")} disabled={busy || !newName.trim()}>
						<Plus className="h-4 w-4" />
					</Button>
				</form>
			</div>,
			document.body,
		)
		: null;

	return (
		<>
			<Tooltip label={count > 0 ? t("label.count", { count }) : t("label.title")}>
				<Button
					ref={triggerRef}
					type="button"
					variant="ghost"
					size="sm"
					className={cn("h-8 gap-1 px-2 text-xs text-neutral-600", open && "bg-neutral-100 text-neutral-900")}
					aria-label={t("label.title")}
					aria-expanded={open}
					onClick={toggleOpen}
				>
					<Tag className="h-4 w-4" />
					{count > 0 && count}
				</Button>
			</Tooltip>
			{panel}
		</>
	);
}
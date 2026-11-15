"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { formatUserDate } from "@/lib/time/utils";
import { apiDelete, apiGet, apiPost } from "./automation-api";

type TokenRow = { id: string; kind: "mailbox" | "app"; mailboxId: string | null; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null };
const SCOPES = ["read", "draft", "send", "manage"] as const;

/** Scoped automation tokens (ain1 mailbox / ain2 app) — the mobile app's credentials. */
export function AccessTokensSettings() {
	const { t } = useLanguage();
	const user = useCurrentUser();
	const { mailboxes, selectedMailbox } = useSelectedMailbox();
	const [tokens, setTokens] = useState<TokenRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [kind, setKind] = useState<"mailbox" | "app">("mailbox");
	const [name, setName] = useState("");
	const [mailboxId, setMailboxId] = useState("");
	const [scopes, setScopes] = useState<string[]>(["read"]);
	const [newToken, setNewToken] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	const refresh = useCallback(() => {
		void apiGet<{ tokens: TokenRow[] }>("/api/scoped-tokens")
			.then((body) => { setTokens(body.tokens); setError(null); })
			.catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load tokens"))
			.finally(() => setLoading(false));
	}, []);
	useEffect(() => { refresh(); }, [refresh]);

	async function create(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const issued = await apiPost<{ token: string }>("/api/scoped-tokens", { kind, name: name.trim(), mailboxId: kind === "mailbox" ? mailboxId : undefined, scopes });
			setNewToken(issued.token);
			setCopied(false);
			setName("");
			refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to create token");
		} finally { setBusy(false); }
	}

	async function revoke(token: TokenRow) {
		if (!await confirmDestructive(t("accessTokens.revokeConfirm", { name: token.name }))) return;
		try {
			await apiDelete(`/api/scoped-tokens?id=${encodeURIComponent(token.id)}`);
			setTokens((current) => current.filter((item) => item.id !== token.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Failed to revoke token");
		}
	}

	const mailboxName = (id: string | null) => {
		const mailbox = mailboxes.find((item) => item.id === id);
		return mailbox ? `${mailbox.localPart}@${mailbox.hostname}` : id ?? "";
	};

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4">
			<h1 className="text-2xl md:text-3xl font-medium">{t("accessTokens.title")}</h1>
			<Dialog open={open} onOpenChange={(next) => { if (busy) return; setOpen(next); setError(null); if (next) { setMailboxId(selectedMailbox?.id ?? mailboxes[0]?.id ?? ""); setKind("mailbox"); setScopes(["read"]); } if (!next) setNewToken(null); }}>
				<DialogTrigger asChild><Button type="button"><Plus className="h-4 w-4" />{t("accessTokens.new")}</Button></DialogTrigger>
				<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{newToken ? t("accessTokens.createdTitle") : t("accessTokens.createTitle")}</DialogTitle>
						<DialogDescription>{newToken ? t("accessTokens.copyNow") : t("accessTokens.description")}</DialogDescription>
					</DialogHeader>
					{!newToken && <form onSubmit={(event) => void create(event)} className="space-y-4">
						<div className="space-y-2"><Label htmlFor="token-name">{t("common.name")}</Label><Input id="token-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder={t("accessTokens.namePlaceholder")} /></div>
						{user?.role === "admin" && <fieldset className="space-y-2">
							<legend className="text-sm font-medium">{t("accessTokens.kind")}</legend>
							<label className="flex items-center gap-3 text-sm"><input type="radio" name="token-kind" checked={kind === "mailbox"} onChange={() => setKind("mailbox")} />{t("accessTokens.kindMailbox")}</label>
							<label className="flex items-center gap-3 text-sm"><input type="radio" name="token-kind" checked={kind === "app"} onChange={() => setKind("app")} />{t("accessTokens.kindApp")}</label>
						</fieldset>}
						{kind === "mailbox" && <div className="space-y-2">
							<Label htmlFor="token-mailbox">{t("accessTokens.mailbox")}</Label>
							<select id="token-mailbox" className="h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)}>
								{mailboxes.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.localPart}@{mailbox.hostname}</option>)}
							</select>
						</div>}
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">{t("accessTokens.scopes")}</legend>
							{SCOPES.map((scope) => <label key={scope} className="flex items-center gap-3 text-sm"><Checkbox checked={scopes.includes(scope)} onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} />{t(`accessTokens.scope.${scope}`)}</label>)}
						</fieldset>
						<Button type="submit" disabled={busy || !name.trim() || !scopes.length || (kind === "mailbox" && !mailboxId)}><KeyRound className="h-4 w-4" />{busy ? t("common.pleaseWait") : t("accessTokens.createTitle")}</Button>
					</form>}
					{newToken && <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
						<code className="block break-all rounded bg-white p-2 text-xs">{newToken}</code>
						<div className="flex gap-2">
							<Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(newToken).then(() => setCopied(true))}><Copy className="h-4 w-4" />{copied ? t("common.copied") : t("common.copy")}</Button>
							<Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); setNewToken(null); }}>{t("common.done")}</Button>
						</div>
					</div>}
					{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
				</DialogContent>
			</Dialog>
		</div>
		<p className="text-sm text-neutral-500">{t("accessTokens.description")}</p>
		{error && !open && <p role="alert" className="text-sm text-red-600">{error}</p>}
		<section className="space-y-3">
			{loading && <SectionRowSkeleton />}
			{!loading && tokens.length === 0 && <p className="text-sm text-neutral-500">{t("accessTokens.empty")}</p>}
			{!loading && tokens.length > 0 && <List>
				{tokens.map((token) => <ListRow key={token.id}>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium">{token.name}</span>
							<Badge variant={token.kind === "app" ? "default" : "secondary"}>{token.kind === "app" ? "ain2" : "ain1"}</Badge>
							{token.scopes.map((scope) => <Badge key={scope} variant="outline">{scope}</Badge>)}
						</div>
						<p className="mt-1 text-xs text-neutral-500">
							{token.kind === "mailbox" ? mailboxName(token.mailboxId) : t("accessTokens.allMailboxes")} · {t("accessTokens.created", { date: formatUserDate(token.createdAt, { dateStyle: "medium" }) })}{token.lastUsedAt ? ` · ${t("accessTokens.lastUsed", { date: formatUserDate(token.lastUsedAt, { dateStyle: "medium" }) })}` : ""}
						</p>
					</div>
					<Button type="button" size="sm" variant="ghost" aria-label={t("common.revoke")} onClick={() => void revoke(token)}><Trash2 className="h-4 w-4" /></Button>
				</ListRow>)}
			</List>}
		</section>
	</div>;
}
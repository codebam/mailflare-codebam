/**
 * Scoped automation token wire format, ported from agentic-inbox
 * (shared/access-tokens.ts). Bearer credentials: shown once at creation,
 * stored only as the SHA-256 hex of the FULL token string.
 *
 *   ain1_<hex mailbox id>_<43-char base64url secret>   one mailbox
 *   ain2_<43-char base64url secret>                    every mailbox
 *
 * The mailbox id segment is the UTF-8 bytes lowercase-hexed: hex keeps the
 * underscore separators unambiguous because the base64url alphabet itself
 * contains "_". The parsers are disjoint — each kind refuses the other.
 */

export const ACCESS_TOKEN_SCOPES = ["read", "draft", "send", "manage"] as const;
export type AccessTokenScope = (typeof ACCESS_TOKEN_SCOPES)[number];

const SECRET_BYTES = 32;
const MAILBOX_TOKEN = /^ain1_([0-9a-f]+)_([A-Za-z0-9_-]{43})$/;
const APP_TOKEN = /^ain2_([A-Za-z0-9_-]{43})$/;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateTokenSecret(): string {
	return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toHex(value: string): string {
	return [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): string | null {
	if (value.length % 2 !== 0) return null;
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
		if (Number.isNaN(byte)) return null;
		bytes[index] = byte;
	}
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

export function formatMailboxToken(mailboxId: string, secret: string): string {
	return `ain1_${toHex(mailboxId)}_${secret}`;
}

export function formatAppToken(secret: string): string {
	return `ain2_${secret}`;
}

export type ParsedToken = { kind: "mailbox"; mailboxId: string; secret: string } | { kind: "app"; secret: string };

/** Disjoint parse: an ain1 string never parses as app, and vice versa. */
export function parseToken(token: string): ParsedToken | null {
	const mailbox = token.match(MAILBOX_TOKEN);
	if (mailbox) {
		const mailboxId = fromHex(mailbox[1]);
		return mailboxId ? { kind: "mailbox", mailboxId, secret: mailbox[2] } : null;
	}
	const app = token.match(APP_TOKEN);
	if (app) return { kind: "app", secret: app[1] };
	return null;
}

export function normalizeScopes(value: unknown): AccessTokenScope[] {
	if (!Array.isArray(value)) return [];
	const scopes = value.filter((scope): scope is AccessTokenScope => typeof scope === "string" && (ACCESS_TOKEN_SCOPES as readonly string[]).includes(scope));
	return [...new Set(scopes)];
}
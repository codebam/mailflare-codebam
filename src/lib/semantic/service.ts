import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messageEmbeddings, messages } from "@/db/schema";

/**
 * Semantic (vector) search over a mailbox's stored mail, ported from
 * agentic-inbox with the binding seam kept: an embedder is injected, so tests
 * pass fakes and runtimes without a model answer SEMANTIC_NOT_CONFIGURED.
 * Bookkeeping lives in message_embeddings (model id + content hash); the
 * vectors themselves are stored as JSON and ranked in-process, which fits
 * mailbox scale on every dialect without a vector index.
 */

export const SEMANTIC_NOT_CONFIGURED = "Semantic search is not configured: set an AI provider (Workers AI binding or AI_BASE_URL/AI_API_KEY) and reindex.";
export const SEMANTIC_SEARCH_LIMIT_MAX = 20;
// Workers AI caps the total input per embedding request. The qwen3 embedder
// accepts long per-text inputs (8192 tokens), so a large batch of full-length
// messages overflows that cap ("3030: input too big"); 8 stays safely under it.
export const SEMANTIC_REINDEX_BATCH_MAX = 8;
/** Plain-text characters of one message (or query) sent to the model. */
export const MAX_EMBEDDING_SOURCE_CHARS = 6000;
export const SEMANTIC_SNIPPET_CHARS = 300;
export const SEMANTIC_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

export type Embedder = {
	model: string;
	embed(texts: string[]): Promise<number[][]>;
};

/** Workers AI binding first, then an OpenAI-compatible endpoint; null when neither exists. */
export function resolveEmbedder(env: unknown): Embedder | null {
	const record = (env ?? {}) as Record<string, unknown>;
	const ai = record.AI as { run?: (model: string, input: unknown) => Promise<{ data: number[][] }> } | undefined;
	if (ai?.run) {
		const model = typeof record.AI_EMBEDDING_MODEL === "string" && record.AI_EMBEDDING_MODEL ? record.AI_EMBEDDING_MODEL : SEMANTIC_EMBEDDING_MODEL;
		return {
			model,
			embed: async (texts) => (await ai.run!(model, { text: texts })).data,
		};
	}
	const baseUrl = typeof record.AI_BASE_URL === "string" ? record.AI_BASE_URL.replace(/\/$/, "") : null;
	const apiKey = typeof record.AI_API_KEY === "string" ? record.AI_API_KEY : null;
	if (baseUrl && apiKey) {
		const model = typeof record.AI_EMBEDDING_MODEL === "string" && record.AI_EMBEDDING_MODEL ? record.AI_EMBEDDING_MODEL : "text-embedding-3-small";
		return {
			model,
			embed: async (texts) => {
				const response = await fetch(`${baseUrl}/embeddings`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
					body: JSON.stringify({ model, input: texts }),
				});
				if (!response.ok) throw new Error(`Embedding provider answered ${response.status}`);
				const body = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
				return body.data.sort((a, b) => a.index - b.index).map((row) => row.embedding);
			},
		};
	}
	return null;
}

/** The text embedded for a message: subject plus body, bounded. */
export function embeddingSource(subject: string | null, textBody: string | null, htmlBody: string | null): string {
	const body = textBody ?? (htmlBody ? htmlBody.replace(/<[^>]+>/g, " ") : "");
	return `${subject ?? ""}\n${body ?? ""}`.replace(/\s+/g, " ").trim().slice(0, MAX_EMBEDDING_SOURCE_CHARS);
}

export async function contentHash(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		dot += a[index] * b[index];
		normA += a[index] * a[index];
		normB += b[index] * b[index];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embed one bounded batch of the mailbox's unembedded (or changed) messages.
 * Idempotent: the content hash skips unchanged mail. Loop while remaining > 0.
 */
export async function reindexBatch(db: AppDatabase, mailboxId: string, embedder: Embedder, limit = SEMANTIC_REINDEX_BATCH_MAX): Promise<{ indexed: number; remaining: number }> {
	const batch = Math.max(1, Math.min(Math.floor(limit), SEMANTIC_REINDEX_BATCH_MAX));
	const candidates = await db
		.select({ id: messages.id, subject: messages.subject, textBody: messages.textBody, htmlBody: messages.htmlBody, contentHash: messageEmbeddings.contentHash, model: messageEmbeddings.model })
		.from(messages)
		.leftJoin(messageEmbeddings, eq(messageEmbeddings.messageId, messages.id))
		.where(eq(messages.mailboxId, mailboxId))
		.orderBy(sql`${messages.createdAt} desc`)
		.limit(500);
	const pending: Array<{ id: string; source: string; hash: string }> = [];
	for (const row of candidates) {
		const source = embeddingSource(row.subject, row.textBody, row.htmlBody);
		if (!source) continue;
		const hash = await contentHash(source);
		if (row.contentHash === hash && row.model === embedder.model) continue;
		pending.push({ id: row.id, source, hash });
	}
	const batchItems = pending.slice(0, batch);
	if (batchItems.length === 0) return { indexed: 0, remaining: 0 };
	const vectors = await embedder.embed(batchItems.map((item) => item.source));
	for (let index = 0; index < batchItems.length; index += 1) {
		const item = batchItems[index];
		const embedding = JSON.stringify(vectors[index]);
		await db
			.insert(messageEmbeddings)
			.values({ messageId: item.id, model: embedder.model, contentHash: item.hash, embedding })
			.onConflictDoUpdate({ target: messageEmbeddings.messageId, set: { model: embedder.model, contentHash: item.hash, embedding, createdAt: new Date() } });
	}
	return { indexed: batchItems.length, remaining: pending.length - batchItems.length };
}

export type SemanticResult = { id: string; subject: string | null; score: number; snippet: string };

/** Rank the mailbox's embedded messages against the query by cosine similarity. */
export async function semanticSearch(db: AppDatabase, mailboxId: string, query: string, embedder: Embedder, limit = 10): Promise<SemanticResult[]> {
	const trimmed = query.trim().slice(0, MAX_EMBEDDING_SOURCE_CHARS);
	if (!trimmed) return [];
	const bounded = Math.max(1, Math.min(Math.floor(limit), SEMANTIC_SEARCH_LIMIT_MAX));
	const rows = await db
		.select({ id: messages.id, subject: messages.subject, textBody: messages.textBody, htmlBody: messages.htmlBody, embedding: messageEmbeddings.embedding })
		.from(messageEmbeddings)
		.innerJoin(messages, eq(messages.id, messageEmbeddings.messageId))
		.where(eq(messages.mailboxId, mailboxId));
	if (rows.length === 0) return [];
	const [queryVector] = await embedder.embed([trimmed]);
	const ranked = rows
		.map((row) => ({ row, score: cosineSimilarity(queryVector, JSON.parse(row.embedding) as number[]) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, bounded);
	return ranked.map(({ row, score }) => ({
		id: row.id,
		subject: row.subject,
		score: Math.round(score * 10000) / 10000,
		snippet: (row.textBody ?? row.htmlBody ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, SEMANTIC_SNIPPET_CHARS),
	}));
}

/** Best-effort single-message indexing off the receive path. */
export async function indexMessageBestEffort(db: AppDatabase, env: unknown, mailboxId: string, messageId: string): Promise<void> {
	const embedder = resolveEmbedder(env);
	if (!embedder) return;
	const [row] = await db.select({ subject: messages.subject, textBody: messages.textBody, htmlBody: messages.htmlBody }).from(messages).where(and(eq(messages.id, messageId), eq(messages.mailboxId, mailboxId))).limit(1);
	if (!row) return;
	const source = embeddingSource(row.subject, row.textBody, row.htmlBody);
	if (!source) return;
	const hash = await contentHash(source);
	const [vector] = await embedder.embed([source]);
	await db
		.insert(messageEmbeddings)
		.values({ messageId, model: embedder.model, contentHash: hash, embedding: JSON.stringify(vector) })
		.onConflictDoUpdate({ target: messageEmbeddings.messageId, set: { model: embedder.model, contentHash: hash, embedding: JSON.stringify(vector), createdAt: new Date() } });
}
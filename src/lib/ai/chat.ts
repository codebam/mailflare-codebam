/**
 * Chat-model seam for the ported AI surfaces (thread summaries today; the
 * classifier, extractor and auto-draft reuse it next). Workers AI binding
 * first, OpenAI-compatible endpoint second, null when neither is configured —
 * callers answer a not-configured error, never a silent no-op.
 */

export type ChatModel = {
	model: string;
	complete(system: string, user: string): Promise<string>;
};

export const AI_NOT_CONFIGURED = "AI is not configured: set a Workers AI binding or AI_BASE_URL/AI_API_KEY.";

export function resolveChatModel(env: unknown): ChatModel | null {
	const record = (env ?? {}) as Record<string, unknown>;
	const ai = record.AI as { run?: (model: string, input: unknown) => Promise<{ response?: string }> } | undefined;
	if (ai?.run) {
		const model = typeof record.AI_CHAT_MODEL === "string" && record.AI_CHAT_MODEL ? record.AI_CHAT_MODEL : "@cf/meta/llama-3.1-8b-instruct";
		return {
			model,
			complete: async (system, user) => {
				const result = await ai.run!(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }] });
				return result.response ?? "";
			},
		};
	}
	const baseUrl = typeof record.AI_BASE_URL === "string" ? record.AI_BASE_URL.replace(/\/$/, "") : null;
	const apiKey = typeof record.AI_API_KEY === "string" ? record.AI_API_KEY : null;
	if (baseUrl && apiKey) {
		const model = typeof record.AI_MODEL === "string" && record.AI_MODEL ? record.AI_MODEL : "gpt-4o-mini";
		return {
			model,
			complete: async (system, user) => {
				const response = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
					body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
				});
				if (!response.ok) throw new Error(`AI provider answered ${response.status}`);
				const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
				return body.choices?.[0]?.message?.content ?? "";
			},
		};
	}
	return null;
}
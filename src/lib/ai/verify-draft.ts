import { resolveChatModel } from "./chat";

/**
 * Draft verification, ported from agentic-inbox: model output sometimes
 * carries commentary ("Here is the draft:") around the actual body. The
 * cleaner strips it; local heuristics handle the common prefixes without a
 * model call, and the model pass is best-effort — any failure returns the
 * original body untouched. Operator-authored content is never rewritten
 * beyond commentary removal.
 */

const COMMENTARY_PREFIX = /^(?:sure[,!.]?\s*|certainly[,!.]?\s*|of course[,!.]?\s*|here(?:'s| is) (?:the |your )?(?:draft|reply|response|email)[:.,]?\s*|draft[:.]\s*|reply[:.]\s*)/i;

/** Local, model-free commentary stripping for the common prefixes. */
export function stripDraftCommentary(body: string): string {
	let text = body.trim();
	// A leading commentary line before a blank line or an HTML block.
	const lines = text.split("\n");
	if (lines.length > 1 && COMMENTARY_PREFIX.test(lines[0]) && lines[0].length < 120) {
		const rest = lines.slice(1).join("\n").trim();
		if (rest) text = rest;
	} else if (COMMENTARY_PREFIX.test(text)) {
		text = text.replace(COMMENTARY_PREFIX, "").trim();
	}
	return text;
}

/**
 * Clean a draft body: local stripping first; when a model is configured and
 * the body still looks like it carries commentary, one bounded model pass.
 * Never throws, never returns empty when the input was non-empty.
 */
export async function cleanDraftBody(env: unknown, body: string): Promise<string> {
	const locally = stripDraftCommentary(body);
	if (!locally) return body;
	const model = resolveChatModel(env, "AI_DRAFT_MODEL");
	if (!model) return locally;
	if (!/^(?:here|sure|certainly|of course|draft|reply|below|as requested)\b/i.test(locally.slice(0, 40))) return locally;
	try {
		const cleaned = await model.complete(
			"You clean email draft bodies. Remove any assistant commentary or preamble (e.g. 'Here is the draft:') and return ONLY the draft body itself, unchanged in wording and formatting. If there is no commentary, return the input exactly. Never add content.",
			locally.slice(0, 20_000),
		);
		const trimmed = cleaned.trim();
		return trimmed || locally;
	} catch {
		return locally;
	}
}
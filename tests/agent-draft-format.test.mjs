import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-agent-draft-format-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { format: join(root, "src/lib/agent/draft-format.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { formatAgentDraftBody } = await import(pathToFileURL(join(outDir, "format.mjs")).href);

test("inline markdown becomes draft plain text and escaped HTML", () => {
	assert.deepEqual(formatAgentDraftBody("**Hi** [there](https://x.test)"), {
		text: "Hi there (https://x.test)",
		html: "<div>Hi there (https://x.test)</div>",
	});
});

test("headings and bullets are flattened, fences dropped", () => {
	const { text, html } = formatAgentDraftBody(
		"# Title\n\n- one\n* two\n+ three\n```md\nignored\n```"
	);
	assert.equal(text, "Title\n\n• one\n• two\n• three\n\nignored");
	assert.equal(html, "<div>Title<br><br>• one<br>• two<br>• three<br><br>ignored</div>");
});

test("every emphasis spelling is stripped", () => {
	assert.equal(formatAgentDraftBody("*a* _b_ ~~c~~ `d` __e__ **f**").text, "a b c d e f");
});

test("CRLF and CR normalize, and runs of blank lines collapse", () => {
	const { text, html } = formatAgentDraftBody("A\r\nB\rC\r\n\r\n\r\nD");
	assert.equal(text, "A\nB\nC\n\nD");
	assert.equal(html, "<div>A<br>B<br>C<br><br>D</div>");
});

test("HTML metacharacters are escaped in the HTML arm only", () => {
	const { text, html } = formatAgentDraftBody('<b> & "q"');
	assert.equal(text, '<b> & "q"');
	assert.equal(html, '<div>&lt;b&gt; &amp; &quot;q&quot;</div>');
});

test("an empty body stays empty in both representations", () => {
	assert.deepEqual(formatAgentDraftBody(""), { text: "", html: "" });
});

test("surrounding blank lines are trimmed", () => {
	assert.equal(formatAgentDraftBody("\n\nHello\n\n").text, "Hello");
});

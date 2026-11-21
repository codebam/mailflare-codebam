import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Callers that do not pass their own translator still need English answers.
// `defaultTranslator` is that shared instance; pin its contract directly.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-default-translator-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const outfile = join(outDir, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/i18n/utils.ts")],
	outfile,
	bundle: true,
	format: "esm",
	platform: "neutral",
	logLevel: "silent",
});
const { defaultTranslator } = await import(pathToFileURL(outfile).href);

test("the default translator answers in English without a catalog", () => {
	assert.equal(defaultTranslator("navigation.inbox"), "Inbox");
});

test("the default translator interpolates vars and applies English plurals", () => {
	assert.equal(defaultTranslator("contacts.sendEmail", { name: "Sam" }), "Send email to Sam");
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 1 }), "1 attachment");
	assert.equal(defaultTranslator("thread.attachmentCount", { count: 2 }), "2 attachments");
});

test("the default translator falls back to the key when nothing is catalogued", () => {
	assert.equal(defaultTranslator("not.a.real.key"), "not.a.real.key");
});

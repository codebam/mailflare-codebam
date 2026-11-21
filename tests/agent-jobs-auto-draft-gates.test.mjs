import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-agent-jobs-gates-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Pin the pure gate used before scheduleAutoDraft touches the database or env.
// It is module-private, so lift the real function out of the source verbatim.
const source = readFileSync(join(root, "src/lib/agent/jobs/utils.ts"), "utf8");
const helper = source.match(/function isAutomaticMessage\([\s\S]*?\n\}/)?.[0];
assert.ok(helper, "isAutomaticMessage helper is present in jobs/utils.ts");
await build({
	stdin: {
		contents: `import { normalizeEmailAddress } from "./src/lib/email/address.ts";\n${helper}\nexport { isAutomaticMessage };`,
		resolveDir: root,
		sourcefile: "agent-jobs-gates-entry.ts",
		loader: "ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { isAutomaticMessage } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("ordinary correspondents are not automatic", () => {
	assert.equal(isAutomaticMessage("Alice <alice@example.com>"), false);
	assert.equal(isAutomaticMessage("reply@example.com"), false);
	assert.equal(isAutomaticMessage("alerts@example.com", { Precedence: "ordinary" }), false);
});

test("role mailboxes are automatic after address normalization", () => {
	for (const from of [
		"mailer-daemon@mx.example.com",
		'"Postmaster" <POSTMASTER@example.com>',
		"No-Reply@example.com",
		"noreply@example.com",
		"Do-Not-Reply@example.com",
		"donotreply@example.com",
	]) assert.equal(isAutomaticMessage(from), true, from);
});

test("auto-reply headers are matched case-insensitively", () => {
	for (const headers of [
		{ "List-ID": "<weekly@example.com>" },
		{ "X-AutoReply": "yes" },
		{ "X-AUTORESPOND": "true" },
		{ "x-auto-response-suppress": "1" },
	]) assert.equal(isAutomaticMessage("person@example.com", headers), true, JSON.stringify(headers));
	assert.equal(isAutomaticMessage("person@example.com", { "X-Other": "yes" }), false);
});

test("Auto-Submitted only suppresses when it is exactly no", () => {
	assert.equal(isAutomaticMessage("person@example.com", { "Auto-Submitted": "auto-generated" }), true);
	assert.equal(isAutomaticMessage("person@example.com", { "auto-submitted": "NO" }), false);
});

test("bulk, junk and list precedence are automatic and other values are not", () => {
	for (const precedence of ["bulk", "JUNK", "List"]) assert.equal(isAutomaticMessage("person@example.com", { precedence }), true, precedence);
	for (const precedence of ["ordinary", "bulky", "", undefined]) assert.equal(isAutomaticMessage("person@example.com", precedence ? { precedence } : {}), false, String(precedence));
});

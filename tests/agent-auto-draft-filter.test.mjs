import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

// isAutomaticMessage is the pure gate that keeps receipts, alerts and list
// mail out of the auto-draft queue. It is module-private, so the bundle under
// test only re-exports that helper; no source file is changed.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src/lib/agent/jobs/utils.ts");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-agent-jobs-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const entry = join(directory, "entry.ts");
const outfile = join(directory, "entry.mjs");
writeFileSync(entry, `export { isAutomaticMessage } from ${JSON.stringify(source)};\n`);
await build({
	entryPoints: [entry],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
	plugins: [{
		name: "expose-pure-helper",
		setup(builder) {
			builder.onLoad({ filter: /[\\/]agent[\\/]jobs[\\/]utils\.ts$/ }, args => ({
				contents: readFileSync(args.path, "utf8") + "\nexport { isAutomaticMessage };\n",
				loader: "ts",
				resolveDir: dirname(args.path),
			}));
		},
	}],
});
const { isAutomaticMessage } = await import(pathToFileURL(outfile).href);

test("a human sender with no special headers needs a reply", () => {
	assert.equal(isAutomaticMessage("Alice <alice@example.com>"), false);
	assert.equal(isAutomaticMessage("alice@example.com", {}), false);
});

test("role addresses are automatic", () => {
	for (const sender of [
		"mailer-daemon@example.com",
		"postmaster@example.com",
		"no-reply@example.com",
		"noreply@example.com",
		"do-not-reply@example.com",
		"donotreply@example.com",
	]) {
		assert.equal(isAutomaticMessage(sender), true, sender);
	}
});

test("list and auto-reply headers mark a message automatic, case-insensitively", () => {
	for (const headers of [
		{ "List-Id": "<dev@example.com>" },
		{ "X-AutoReply": "yes" },
		{ "X-AutoRespond": "yes" },
		{ "X-Auto-Response-Suppress": "All" },
		{ "AUTO-SUBMITTED": "auto-generated" },
	]) {
		assert.equal(isAutomaticMessage("alice@example.com", headers), true, JSON.stringify(headers));
	}
});

test("Auto-Submitted: no is not automatic, and Precedence only matches bulk/junk/list", () => {
	assert.equal(isAutomaticMessage("alice@example.com", { "auto-submitted": "no" }), false);
	for (const precedence of ["bulk", "junk", "list"]) {
		assert.equal(isAutomaticMessage("alice@example.com", { Precedence: precedence }), true, precedence);
	}
	assert.equal(isAutomaticMessage("alice@example.com", { Precedence: "normal" }), false);
});

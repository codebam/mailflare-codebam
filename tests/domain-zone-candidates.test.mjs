import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Zone lookup walks a hostname from itself up through its parents, stopping
// before the bare TLD so a Cloudflare zone listing never has to answer for "uk".

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-zone-candidates-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const outfile = join(outDir, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/domains/utils.ts")],
	outfile,
	bundle: true,
	format: "esm",
	platform: "neutral",
	logLevel: "silent",
});
const { getZoneLookupCandidates } = await import(pathToFileURL(outfile).href);

test("a hostname yields each parent zone down to the registrable domain", () => {
	assert.deepEqual(getZoneLookupCandidates("mail.example.co.uk"), [
		"mail.example.co.uk",
		"example.co.uk",
		"co.uk",
	]);
});

test("an apex hostname yields only itself", () => {
	assert.deepEqual(getZoneLookupCandidates("example.com"), ["example.com"]);
});

test("a single label has no parent zone to look up", () => {
	assert.deepEqual(getZoneLookupCandidates("localhost"), []);
});

test("empty labels from repeated or trailing dots are skipped", () => {
	assert.deepEqual(getZoneLookupCandidates("mail..example.com."), ["mail.example.com", "example.com"]);
});

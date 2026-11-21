import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Domain input is normalized before validation and zone lookup, so pin its
// canonical form: trim/lowercase, no trailing dot, punycode for IDNs.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-normalize-hostname-"));
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
const { normalizeHostname } = await import(pathToFileURL(outfile).href);

test("normalizeHostname trims, lowercases and drops trailing dots", () => {
	assert.equal(normalizeHostname("  Example.COM  "), "example.com");
	assert.equal(normalizeHostname("example.com."), "example.com");
	assert.equal(normalizeHostname("EXAMPLE.COM..."), "example.com");
	assert.equal(normalizeHostname("..."), "");
	assert.equal(normalizeHostname(""), "");
});

test("normalizeHostname punycodes internationalised names", () => {
	assert.equal(normalizeHostname("Bücher.example"), "xn--bcher-kva.example");
	assert.equal(normalizeHostname("例え.テスト"), "xn--r8jz45g.xn--zckzah");
});

test("normalizeHostname leaves unreadable input trimmed and lowercased", () => {
	// The URL parser would reject these; callers get back the plain
	// trimmed/lowercased string so a validity check can reject it.
	assert.equal(normalizeHostname("exa mple.com"), "exa mple.com");
	assert.equal(normalizeHostname("user@example.com"), "user@example.com");
	assert.equal(normalizeHostname("example.com:8080"), "example.com:8080");
	assert.equal(normalizeHostname("http://example.com"), "http://example.com");
});

test("normalizeHostname keeps ordinary hosts and IP literals intact", () => {
	assert.equal(normalizeHostname("mail.example.co.uk"), "mail.example.co.uk");
	assert.equal(normalizeHostname("127.0.0.1"), "127.0.0.1");
});

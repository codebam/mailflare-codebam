import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The domain helper module is pure (no Workers bindings or DB), so pin it
// directly rather than only through the add-domain validation schemas.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "tests", ".tmp-domain-utils-pure-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const outfile = join(directory, "utils.mjs");
await build({
	entryPoints: [join(root, "src/lib/domains/utils.ts")],
	outfile,
	bundle: true,
	format: "esm",
	platform: "neutral",
	logLevel: "silent",
});
const {
	normalizeHostname,
	isValidHostname,
	getZoneLookupCandidates,
	isZoneApex,
} = await import(pathToFileURL(outfile).href);

test("normalizeHostname trims, lowercases and drops trailing dots", () => {
	assert.equal(normalizeHostname("  Example.COM. "), "example.com");
	assert.equal(normalizeHostname("mail.example.com..."), "mail.example.com");
});

test("normalizeHostname punycodes internationalised names", () => {
	assert.equal(normalizeHostname("münchen.de"), "xn--mnchen-3ya.de");
});

test("normalizeHostname returns unreadable input trimmed and lowercased", () => {
	assert.equal(normalizeHostname(""), "");
	assert.equal(normalizeHostname("https://Example.com"), "https://example.com");
	assert.equal(normalizeHostname("a b.example.com"), "a b.example.com");
});

test("isValidHostname accepts dotted names but rejects IPs and single labels", () => {
	assert.equal(isValidHostname("example.com"), true);
	assert.equal(isValidHostname("mail.example.com"), true);
	assert.equal(isValidHostname("xn--mnchen-3ya.de"), true);
	assert.equal(isValidHostname("example"), false);
	assert.equal(isValidHostname("1.2.3.4"), false);
	assert.equal(isValidHostname("0x7f.1"), false);
	assert.equal(isValidHostname("example..com"), false);
	assert.equal(isValidHostname("-bad.example.com"), false);
	assert.equal(isValidHostname("https://example.com"), false);
});

test("getZoneLookupCandidates walks from the full name to the registrable name", () => {
	assert.deepEqual(getZoneLookupCandidates("mail.example.com"), ["mail.example.com", "example.com"]);
	assert.deepEqual(getZoneLookupCandidates("example.com"), ["example.com"]);
	assert.deepEqual(getZoneLookupCandidates("a.b.c.d"), ["a.b.c.d", "b.c.d", "c.d"]);
	assert.deepEqual(getZoneLookupCandidates("example"), []);
	assert.deepEqual(getZoneLookupCandidates(""), []);
});

test("getZoneLookupCandidates ignores empty labels", () => {
	assert.deepEqual(getZoneLookupCandidates(".example.com."), ["example.com"]);
});

test("isZoneApex matches only the exact zone name", () => {
	assert.equal(isZoneApex("example.com", "example.com"), true);
	assert.equal(isZoneApex("mail.example.com", "example.com"), false);
	assert.equal(isZoneApex("example.com.", "example.com"), false);
});

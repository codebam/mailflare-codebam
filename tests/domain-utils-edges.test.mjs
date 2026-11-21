import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Pin the normalization the domain layer relies on: case, trailing dots, IDN
// punycode, and the early return for input the URL parser must never see.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-utils-edges-"));
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

test("trims, lowercases, and strips trailing dots", () => {
	assert.equal(normalizeHostname("  Example.COM.  "), "example.com");
	assert.equal(normalizeHostname("EXAMPLE.COM.."), "example.com");
	assert.equal(normalizeHostname("example.com"), "example.com");
});

test("punycodes internationalised labels", () => {
	assert.equal(normalizeHostname("BÜCHER.example"), "xn--bcher-kva.example");
});

test("empty and dot-only hostnames stay empty", () => {
	assert.equal(normalizeHostname(""), "");
	assert.equal(normalizeHostname("   "), "");
	assert.equal(normalizeHostname("..."), "");
});

test("URL-significant characters bypass the parser and are only trimmed and lowercased", () => {
	assert.equal(normalizeHostname("User@Example.COM"), "user@example.com");
	assert.equal(normalizeHostname("example.com:8080"), "example.com:8080");
	assert.equal(normalizeHostname("http://example.com"), "http://example.com");
	assert.equal(normalizeHostname("exa mple.com"), "exa mple.com");
	assert.equal(normalizeHostname("foo?bar#baz"), "foo?bar#baz");
	assert.equal(normalizeHostname("foo\\bar"), "foo\\bar");
});

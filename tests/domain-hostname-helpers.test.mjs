import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The domain form normalises before storing and validates before provisioning;
// both steps call the pure hostname helpers in src/lib/domains/utils.ts.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "tests", ".tmp-domain-hostname-helpers-"));
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
const { normalizeHostname, isValidHostname } = await import(pathToFileURL(outfile).href);

test("normalizeHostname folds case, surrounding space and trailing dots", () => {
	assert.equal(normalizeHostname("  Example.COM. "), "example.com");
	assert.equal(normalizeHostname("mail.example.com."), "mail.example.com");
	assert.equal(normalizeHostname("example.com..."), "example.com");
	assert.equal(normalizeHostname("EXAMPLE.COM"), "example.com");
});

test("normalizeHostname punycodes internationalised names and normalises IPv4", () => {
	assert.equal(normalizeHostname("münchen.de"), "xn--mnchen-3ya.de");
	assert.equal(normalizeHostname("192.168.1.1."), "192.168.1.1");
});

test("normalizeHostname returns input the URL parser cannot own, still trimmed and lowercased", () => {
	for (const input of ["", "   ", "https://Example.com", "a b.com", "user@example.com", "example.com:443", "[::1]"]) {
		assert.equal(normalizeHostname(input), input.trim().toLowerCase(), input);
	}
});

test("isValidHostname accepts dotted names, including punycode", () => {
	for (const hostname of ["example.com", "mail.example.com", "a-b.example.com", "example.co", "xn--mnchen-3ya.de"]) {
		assert.equal(isValidHostname(hostname), true, hostname);
	}
});

test("isValidHostname rejects single labels, malformed labels and trailing dots", () => {
	for (const hostname of ["example", "a..b.com", "-bad.example.com", "bad-.example.com", "UPPER.com", "example.com.", "münchen.de"]) {
		assert.equal(isValidHostname(hostname), false, hostname);
	}
});

test("isValidHostname rejects IPs even in forms the URL parser turns into IPv4", () => {
	for (const hostname of ["1.2.3.4", "127.0.0.1", "0x7f.1", "0x7f.0.0.1", "2130706433", "192.168.1.1."]) {
		assert.equal(isValidHostname(hostname), false, hostname);
	}
});

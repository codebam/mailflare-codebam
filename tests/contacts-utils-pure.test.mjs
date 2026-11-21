import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-contacts-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/contacts/utils.ts")],
	outfile: join(outDir, "contacts.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	external: ["react", "react-dom", "next", "next/*"],
});
const contacts = await import(pathToFileURL(join(outDir, "contacts.mjs")).href);

// getPartyDisplayName is already pinned in recipient-display.test.mjs; these are the other helpers.

test("getContactId trims and lowercases the email", () => {
	assert.equal(contacts.getContactId("u1", "  Alice@Example.COM  "), "u1:alice@example.com");
	assert.equal(contacts.getContactId("user_42", "Bob@EXAMPLE.test"), "user_42:bob@example.test");
	assert.equal(contacts.getContactId("u1", "ALICE@example.com"), "u1:alice@example.com");
});

test("getContactNameFromAddress returns only a genuine header name", () => {
	assert.equal(contacts.getContactNameFromAddress('"Alice" <alice@example.com>'), "Alice");
	assert.equal(contacts.getContactNameFromAddress("Alice <alice@example.com>"), "Alice");
	assert.equal(contacts.getContactNameFromAddress("  Alice  <alice@example.com>"), "Alice");
	assert.equal(contacts.getContactNameFromAddress("alice@example.com"), null);
	// A name identical to the address is not a real name.
	assert.equal(contacts.getContactNameFromAddress('"alice@example.com" <alice@example.com>'), null);
	assert.equal(contacts.getContactNameFromAddress(""), null);
});

test("getDisplayNameForAddress prefers a trimmed contact name, then the header name", () => {
	assert.equal(contacts.getDisplayNameForAddress('"Alice" <alice@example.com>'), "Alice");
	assert.equal(contacts.getDisplayNameForAddress('"Alice" <alice@example.com>', "  Alice Smith  "), "Alice Smith");
	// A whitespace-only contact name falls through to the address-derived name.
	assert.equal(contacts.getDisplayNameForAddress('"Alice" <alice@example.com>', "   "), "Alice");
	assert.equal(contacts.getDisplayNameForAddress("bob@example.com"), "bob");
	assert.equal(contacts.getDisplayNameForAddress("bob@example.com", null), "bob");
});

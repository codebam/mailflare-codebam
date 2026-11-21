import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-password-hash-guard-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { PASSWORDLESS_PASSWORD_HASH, hasPasswordHash, hashPassword } from "./src/lib/auth/password.ts";
		`,
		resolveDir: root,
		sourcefile: "password-hash-guard-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { PASSWORDLESS_PASSWORD_HASH, hasPasswordHash, hashPassword } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("PASSWORDLESS_PASSWORD_HASH is the passkey-only sentinel", () => {
	assert.equal(PASSWORDLESS_PASSWORD_HASH, "!passkey-only");
});

test("hasPasswordHash accepts only real bcrypt hashes", () => {
	assert.equal(hasPasswordHash("$2b$12$abcdefghijklmnopqrstuv"), true);
	assert.equal(hasPasswordHash("$2a$10$abcdefghijklmnopqrstuv"), true);
	assert.equal(hasPasswordHash("$2y$12$abcdefghijklmnopqrstuv"), true);
	assert.equal(hasPasswordHash(hashPassword("secret")), true);
});

test("hasPasswordHash rejects missing, sentinel and non-bcrypt values", () => {
	assert.equal(hasPasswordHash(null), false);
	assert.equal(hasPasswordHash(undefined), false);
	assert.equal(hasPasswordHash(""), false);
	assert.equal(hasPasswordHash(PASSWORDLESS_PASSWORD_HASH), false);
	assert.equal(hasPasswordHash("plaintext"), false);
	assert.equal(hasPasswordHash("$1$md5hash"), false);
	assert.equal(hasPasswordHash(" $2b$12$leadingspace"), false);
});

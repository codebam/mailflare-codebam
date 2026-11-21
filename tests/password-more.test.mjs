import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "password-more-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { PASSWORDLESS_PASSWORD_HASH, hashPassword, hasPasswordHash, verifyPassword } from "./src/lib/auth/password.ts";
		`,
		resolveDir: root,
		sourcefile: "password-more-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
});

const { PASSWORDLESS_PASSWORD_HASH, hashPassword, hasPasswordHash, verifyPassword } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("hasPasswordHash accepts only real bcrypt hashes", () => {
	assert.equal(PASSWORDLESS_PASSWORD_HASH, "!passkey-only");
	assert.equal(hasPasswordHash("$2b$12$abcdefghijklmnopqrstuv"), true);
	assert.equal(hasPasswordHash("$2a$10$abcdefghijklmnopqrstuv"), true);
	assert.equal(hasPasswordHash("$2y$12$abcdefghijklmnopqrstuv"), true);
	assert.equal(hasPasswordHash(null), false);
	assert.equal(hasPasswordHash(undefined), false);
	assert.equal(hasPasswordHash(""), false);
	assert.equal(hasPasswordHash(PASSWORDLESS_PASSWORD_HASH), false);
	assert.equal(hasPasswordHash("plaintext"), false);
	assert.equal(hasPasswordHash("$1$md5crypt"), false);
});

test("verifyPassword rejects missing and non-bcrypt hashes without throwing", () => {
	assert.equal(verifyPassword("pw", null), false);
	assert.equal(verifyPassword("pw", undefined), false);
	assert.equal(verifyPassword("pw", ""), false);
	assert.equal(verifyPassword("pw", PASSWORDLESS_PASSWORD_HASH), false);
	assert.equal(verifyPassword("pw", "plaintext"), false);
});

test("verifyPassword matches a hash produced by hashPassword", () => {
	const hash = hashPassword("correct horse battery");
	assert.match(hash, /^\$2[aby]\$12\$/);
	assert.equal(verifyPassword("correct horse battery", hash), true);
	assert.equal(verifyPassword("wrong", hash), false);
});

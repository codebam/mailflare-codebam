import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-password-guards-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
        entryPoints: [join(root, "src/lib/auth/password.ts")],
        outfile: join(outDir, "entry.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        logLevel: "silent",
});
const { PASSWORDLESS_PASSWORD_HASH, hasPasswordHash, verifyPassword } = await import(
        pathToFileURL(join(outDir, "entry.mjs")).href
);

test("the passkey sentinel is never a usable password hash", () => {
        assert.equal(PASSWORDLESS_PASSWORD_HASH, "!passkey-only");
        for (const value of [null, undefined, "", "plaintext", PASSWORDLESS_PASSWORD_HASH]) {
                assert.equal(hasPasswordHash(value), false, String(value));
        }
        assert.equal(hasPasswordHash("$2b$12$abcdefghijklmnopqrstuv"), true);
});

test("verifyPassword short-circuits on missing, sentinel and non-bcrypt hashes", () => {
        for (const value of [null, undefined, "", "plaintext", PASSWORDLESS_PASSWORD_HASH]) {
                assert.equal(verifyPassword("anything", value), false, String(value));
        }
});

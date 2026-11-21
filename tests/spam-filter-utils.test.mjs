import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-spam-filter-utils-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/app/(admin)/spam-filter/utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	plugins: [{
		name: "stub-auth-client",
		setup(builder) {
			builder.onLoad({ filter: /[\\/]lib[\\/]auth[\\/]client\.ts$/ }, () => ({
				contents: "export async function authFetch() { throw new Error('authFetch must not be called'); }",
				loader: "ts",
			}));
		},
	}],
	logLevel: "silent",
});

const { SPAMHAUS_SIGNUP_URL, ABUSECH_SIGNUP_URL } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("provider signup links point at the provider account pages", () => {
	assert.equal(SPAMHAUS_SIGNUP_URL, "https://www.spamhaus.com/data-access/free-data-query-service/");
	assert.equal(ABUSECH_SIGNUP_URL, "https://auth.abuse.ch/");
});

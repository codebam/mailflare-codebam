import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-admin-update-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { POST } from "./src/app/api/admin/update/POST";`,
		resolveDir: root,
		sourcefile: "admin-update-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
	plugins: [{
		name: "update-runtime-stubs",
		setup(builder) {
			builder.onResolve({ filter: /^(next\/server|@\/lib\/runtime)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
			builder.onLoad({ filter: /[\\/]admin[\\/]update[\\/]utils\.ts$/ }, () => ({
				contents: `
					export async function authorizeAdminRequest() {
						return globalThis.updateAuthError
							? { error: Response.json({ error: "Unauthorized" }, { status: 401 }) }
							: { env: {} };
					}
					export async function dispatchUpdateWorkflow() {
						globalThis.updateDispatched = true;
						return { ok: true };
					}
					export async function getUpdateStatus() { return {}; }
				`,
				loader: "ts",
			}));
			builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
				contents: path === "next/server"
					? "export const NextResponse = { json: (data, init) => Response.json(data, init) };"
					: "export function isNodeRuntime() { return !!globalThis.updateNodeRuntime; }",
				loader: "js",
			}));
		},
	}],
});
const { POST } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
const request = () => new Request("https://mail.test/api/admin/update", { method: "POST" });

test("the fork refuses to dispatch the tree-replacing update workflow", async () => {
	globalThis.updateNodeRuntime = false;
	globalThis.updateAuthError = false;
	globalThis.updateDispatched = false;
	const response = await POST(request());
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /rebasing onto upstream/);
	assert.equal(globalThis.updateDispatched, false);
});

test("node installs keep the container-image guidance", async () => {
	globalThis.updateNodeRuntime = true;
	globalThis.updateAuthError = false;
	const response = await POST(request());
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /container image/);
});

test("unauthorized callers are rejected before any update logic", async () => {
	globalThis.updateAuthError = true;
	const response = await POST(request());
	assert.equal(response.status, 401);
});
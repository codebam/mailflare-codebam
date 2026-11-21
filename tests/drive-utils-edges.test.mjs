import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-drive-utils-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// Only the pure URL/formatting helpers are exercised; the React icon map is irrelevant here.
await build({
	entryPoints: [join(root, "src/app/(drive)/drive-utils.ts")],
	outfile: join(outDir, "drive.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "stub-icons",
		setup(builder) {
			builder.onLoad({ filter: /components[\\/]icons\.tsx$/ }, () => ({
				contents: "export const File=0,FileArchive=0,FileAudio=0,FileCode=0,FileImage=0,FileSpreadsheet=0,FileText=0,FileVideo=0,Folder=0,Presentation=0;",
				loader: "js",
			}));
		},
	}],
});
const drive = await import(pathToFileURL(join(outDir, "drive.mjs")).href);

test("contentUrl encodes ids and adds the download flag only when asked", () => {
	assert.equal(drive.contentUrl("abc"), "/api/drive/items/abc/content");
	assert.equal(drive.contentUrl("abc", true), "/api/drive/items/abc/content?download=1");
	assert.equal(drive.contentUrl("a/b c?d", true), "/api/drive/items/a%2Fb%20c%3Fd/content?download=1");
});

test("driveFileUrl routes mail-backed items to attachments and plain items to content", () => {
	const source = { direction: "inbound", messageId: "msg/1" };
	assert.equal(drive.driveFileUrl({ id: "att/1", source }), "/api/drive/attachments/att%2F1/content");
	assert.equal(drive.driveFileUrl({ id: "att/1", source }, true), "/api/drive/attachments/att%2F1/content?download=1");
	assert.equal(drive.driveFileUrl({ id: "file/1", source: null }), "/api/drive/items/file%2F1/content");
	assert.equal(drive.driveFileUrl({ id: "file/1", source: undefined }, true), "/api/drive/items/file%2F1/content?download=1");
});

test("emailUrl maps direction to sent or inbox and encodes the message id", () => {
	assert.equal(drive.emailUrl({ direction: "outbound", messageId: "m/1" }), "/sent/m%2F1");
	assert.equal(drive.emailUrl({ direction: "inbound", messageId: "m/1" }), "/inbox/m%2F1");
});

test("publicContentUrl encodes token and item id and toggles download/content", () => {
	assert.equal(drive.publicContentUrl("tok/1", "item 2"), "/api/drive/public/tok%2F1?item=item%202&content=1");
	assert.equal(drive.publicContentUrl("tok/1", "item 2", true), "/api/drive/public/tok%2F1?item=item%202&download=1");
});

test("canPreview accepts common media and text types but not SVG or unknown types", () => {
	for (const type of ["image/png", "video/mp4", "audio/mpeg", "application/pdf", "text/plain", "text/csv", "application/json"]) {
		assert.equal(drive.canPreview(type), true, type);
	}
	for (const type of ["image/svg+xml", "text/html", "application/zip", "application/octet-stream", ""]) {
		assert.equal(drive.canPreview(type), false, type);
	}
});

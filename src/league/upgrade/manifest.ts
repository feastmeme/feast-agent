import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * A release's manifest (task 975, run 23, rail a): every file of the tag with its sha256, and a detached Ed25519
 * signature over the manifest's exact bytes. The release carries both in its own tree (`release/manifest.json`,
 * `release/manifest.sig`); `tools/release-sign.mjs` writes them from `git ls-files` before the tag is made. The
 * runtime checks every file of what it fetched against the manifest (and nothing more is there), and the signature
 * with the public key it ships (`release-key.ts`) before it switches to it.
 */

export const MANIFEST_PATH = "release/manifest.json";
export const SIGNATURE_PATH = "release/manifest.sig";
/** What a fetched tree has that the tag does not: git's own folder, the installed packages, the installer's mark. */
const NOT_OF_THE_TAG = new Set([".git", "node_modules", ".feast-installed"]);

export type Manifest = { version: 1; tag: string; files: Record<string, string> };

/** The tree's files, as the manifest names them (forward slashes, sorted), without the manifest's own two. */
export function treeFiles(root: string): { files: string[]; links: string[] } {
  const files: string[] = [];
  const links: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      if (dir === root && NOT_OF_THE_TAG.has(name)) continue;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) links.push(rel);
      else if (st.isDirectory()) walk(path);
      else if (rel !== MANIFEST_PATH && rel !== SIGNATURE_PATH) files.push(rel);
    }
  };
  walk(root);
  return { files: files.sort(), links: links.sort() };
}

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The manifest of a tree (the tests' and the dry run's; the release's own comes from `tools/release-sign.mjs`). */
export function buildManifest(root: string, tag: string, files = treeFiles(root).files): Manifest {
  return { version: 1, tag, files: Object.fromEntries([...files].sort().map((f) => [f, sha256File(join(root, f))])) };
}

/** The bytes that are signed: the manifest as JSON with its files in order, and a final newline. */
export const manifestBytes = (m: Manifest) => Buffer.from(`${JSON.stringify({ version: m.version, tag: m.tag, files: Object.fromEntries(Object.entries(m.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2)}\n`);

export function readManifest(root: string): { manifest: Manifest; bytes: Buffer; signature: string | null } | { error: string } {
  const path = join(root, MANIFEST_PATH);
  if (!existsSync(path)) return { error: "the release carries no manifest (release/manifest.json)" };
  const bytes = readFileSync(path);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8")) as Manifest;
  } catch {
    return { error: "the release's manifest is not JSON" };
  }
  if (manifest?.version !== 1 || typeof manifest.tag !== "string" || typeof manifest.files !== "object" || manifest.files === null) return { error: "the release's manifest is not one this runtime reads" };
  const sig = join(root, SIGNATURE_PATH);
  return { manifest, bytes, signature: existsSync(sig) ? readFileSync(sig, "utf8").trim() : null };
}

/** Every file the manifest names, with its hash, and no file it does not name; no link anywhere. */
export function verifyTree(root: string, manifest: Manifest): { ok: true; files: number } | { ok: false; why: string } {
  const { files, links } = treeFiles(root);
  if (links.length > 0) return { ok: false, why: `the release holds a link (${links[0]})` };
  const named = Object.keys(manifest.files).sort();
  const extra = files.filter((f) => !(f in manifest.files));
  if (extra.length > 0) return { ok: false, why: `a file the manifest does not name: ${extra[0]}` };
  for (const f of named) {
    if (!/^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/.test(f) || f.split("/").includes("..")) return { ok: false, why: `the manifest names an odd path: ${f.slice(0, 80)}` };
    const path = join(root, f);
    if (!existsSync(path)) return { ok: false, why: `a file the manifest names is missing: ${f}` };
    if (sha256File(path) !== manifest.files[f]) return { ok: false, why: `a file differs from the manifest: ${f}` };
  }
  return { ok: true, files: named.length };
}

/** The detached signature (base64 Ed25519) over the manifest's bytes, by the release key. */
export function verifySignature(bytes: Buffer, signature: string | null, publicKeyPem: string): boolean {
  if (!signature) return false;
  try {
    return verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

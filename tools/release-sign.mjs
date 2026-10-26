#!/usr/bin/env node
// The release's manifest and its signature (task 975, run 23): what `FL upgrade` and the opt-in auto-upgrade check
// before they switch to a release. Plain Node, no dependency.
//
//   node tools/release-sign.mjs keygen --out <a folder OUTSIDE this repository>
//       a new Ed25519 key pair: <out>/feast-release.key (the private key, mode 0600: it never enters a repository)
//       and <out>/feast-release.pub; the public key is printed, for src/league/upgrade/release-key.ts.
//   node tools/release-sign.mjs manifest --tag league-vN.M.P
//       release/manifest.json: every file `git ls-files` names (the tag's tree), with its sha256.
//   node tools/release-sign.mjs sign --key <out>/feast-release.key
//       release/manifest.sig: the detached signature (base64) over the manifest's exact bytes.
//   node tools/release-sign.mjs verify --pub <out>/feast-release.pub
//       the signature, and every file against the manifest, as the runtime checks them.
//
// The order for a release: manifest, sign, commit the two files, tag that commit, push (docs/league/upgrade.md).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "release/manifest.json";
const SIGNATURE = "release/manifest.sig";
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(flag("root") ?? ROOT);
const fail = (line) => {
  console.error(`release-sign: ${line}`);
  process.exit(2);
};
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** The same bytes as the runtime's `manifestBytes`: files in order, two-space JSON, a final newline. */
const bytesOf = (m) => Buffer.from(`${JSON.stringify({ version: m.version, tag: m.tag, files: Object.fromEntries(Object.entries(m.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2)}\n`);

switch (args[0]) {
  case "keygen": {
    const out = flag("out");
    if (!out) fail("keygen --out <a folder outside this repository>");
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const real = realpathSync(out);
    const repo = realpathSync(ROOT);
    if (real === repo || real.startsWith(`${repo}${sep}`)) fail("the private key never goes inside the repository: choose a folder outside it");
    const keyPath = join(real, "feast-release.key");
    if (existsSync(keyPath)) fail(`${keyPath} exists: a key is never overwritten`);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const pub = publicKey.export({ type: "spki", format: "pem" });
    writeFileSync(join(real, "feast-release.pub"), pub, { mode: 0o644 });
    console.log(`private key: ${keyPath} (mode 0600; keep it here, back it up offline, never commit it)`);
    console.log("public key, for src/league/upgrade/release-key.ts:");
    console.log(pub.trim());
    break;
  }
  case "manifest": {
    const tag = flag("tag");
    if (!tag || !/^league-v\d{1,4}(\.\d{1,3}){0,2}$/.test(tag)) fail("manifest --tag league-vN.M.P");
    const headers = readFileSync(join(root, "src/league/headers.ts"), "utf8");
    const release = /RUNTIME_RELEASE = "([^"]+)"/.exec(headers)?.[1];
    if (release !== tag) fail(`the tree's RUNTIME_RELEASE is ${release ?? "missing"}, not ${tag}`);
    const listed = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const files = Object.fromEntries(listed.filter((f) => f !== MANIFEST && f !== SIGNATURE).sort().map((f) => [f, sha256(join(root, f))]));
    mkdirSync(join(root, "release"), { recursive: true });
    writeFileSync(join(root, MANIFEST), bytesOf({ version: 1, tag, files }));
    console.log(`${MANIFEST}: ${Object.keys(files).length} files, tag ${tag}`);
    break;
  }
  case "sign": {
    const key = flag("key");
    if (!key) fail("sign --key <path to feast-release.key>");
    const bytes = readFileSync(join(root, MANIFEST));
    const signature = sign(null, bytes, createPrivateKey(readFileSync(key))).toString("base64");
    writeFileSync(join(root, SIGNATURE), `${signature}\n`);
    console.log(`${SIGNATURE}: signed`);
    break;
  }
  case "verify": {
    const pub = flag("pub");
    if (!pub) fail("verify --pub <path to feast-release.pub>");
    const bytes = readFileSync(join(root, MANIFEST));
    const manifest = JSON.parse(bytes.toString("utf8"));
    const signature = readFileSync(join(root, SIGNATURE), "utf8").trim();
    const ok = verify(null, bytes, createPublicKey(readFileSync(pub)), Buffer.from(signature, "base64"));
    if (!ok) fail("the signature does not verify");
    for (const [f, hash] of Object.entries(manifest.files)) if (sha256(join(root, f)) !== hash) fail(`${f} differs from the manifest`);
    console.log(`verified: ${manifest.tag}, ${Object.keys(manifest.files).length} files, signature good`);
    break;
  }
  default:
    fail("keygen | manifest | sign | verify (see the head of this file)");
}

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { AVATAR_MAX_BYTES } from "./constants.ts";

/**
 * The meme a player may launch with `FL enter --meme "<concept>"` or `FL meme "<concept>"` (task 968). The
 * runtime calls no model: the host composes the coin's name, symbol and one-sentence description from the
 * player's concept and passes them; the runtime holds them to the league's rules here, and shows what it will
 * launch on a preview card before any yes. Pure functions, and one bounded file read for the host's picture.
 */

export const MEME_NAME_MAX = 20;
export const MEME_SYMBOL_MAX = 8;
export const MEME_DESCRIPTION_MAX = 140;
export const MEME_CONCEPT_MAX = 120;
/** The league's mark: every meme's name ends with it. */
export const FEED = "feed";

export type MemeInput = { concept: string; name?: string; symbol?: string; description?: string };

export type Meme = { ok: true; concept: string; name: string; symbol: string; description: string; changed: string[] };

export type MemeRefusal = { ok: false; reason: "concept-empty" | "concept-too-long" | "name-empty" | "symbol-empty" | "description-empty" | "description-too-long" | "description-address" | "description-url" | "description-lines" };

/** Control, format, bidi and zero-width characters: never in anything the card shows or the chain keeps. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const fold = (raw: string) => raw.normalize("NFKC").replace(UNSEEN, "").replace(/\s+/gu, " ").trim();
const ADDRESS = /0x[0-9a-fA-F]{40}/;
const URL_LIKE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|io|xyz|meme|net|org|app|gg|co|fun|finance|exchange|top|vip|link|site|online|info|me|tv|ly)\b/i;

/** A field kept to the characters it may hold, and whether anything was dropped. */
function keep(raw: string, allowed: RegExp): { text: string; dropped: boolean } {
  const folded = fold(raw);
  const text = [...folded].filter((c) => allowed.test(c)).join("").replace(/ {2,}/g, " ").trim();
  return { text, dropped: text !== folded };
}

/** The host's composition, held to the rules: plain characters, `feed` at the end of the name, the lengths. */
export function composeMeme(input: MemeInput): Meme | MemeRefusal {
  const concept = fold(input.concept ?? "");
  if (concept === "") return { ok: false, reason: "concept-empty" };
  if ([...concept].length > MEME_CONCEPT_MAX) return { ok: false, reason: "concept-too-long" };
  const changed: string[] = [];

  // The name: letters, digits and spaces; it ends with "feed", which is never the part that is cut.
  const name = keep(input.name ?? "", /[A-Za-z0-9 ]/);
  if (name.dropped) changed.push("name: characters other than letters, digits and spaces were dropped");
  const hadFeed = /feed$/i.test(name.text);
  // The stem keeps a space before "feed" only when the host wrote one.
  const stemRaw = hadFeed ? name.text.slice(0, -FEED.length) : name.text;
  if (stemRaw.trim() === "") return { ok: false, reason: "name-empty" };
  if (!name.text.endsWith(FEED)) changed.push(hadFeed ? `name: the ending is written "${FEED}"` : `name: "${FEED}" was added at the end`);
  let stem = stemRaw.slice(0, MEME_NAME_MAX - FEED.length);
  if (stem.length < stemRaw.length) {
    stem = stem.trimEnd();
    changed.push(`name: cut to ${MEME_NAME_MAX} characters, keeping "${FEED}"`);
  }
  const finalName = `${stem}${FEED}`;

  // The symbol: capitals and digits; a short stem takes FEED, a longer one is cut to 8.
  const symbol = keep((input.symbol ?? "").toUpperCase(), /[A-Z0-9]/);
  if (symbol.dropped) changed.push("symbol: characters other than A–Z and 0–9 were dropped");
  if (symbol.text === "") return { ok: false, reason: "symbol-empty" };
  let finalSymbol = symbol.text;
  if (!finalSymbol.endsWith("FEED") && finalSymbol.length <= 4) {
    finalSymbol = `${finalSymbol}FEED`;
    changed.push('symbol: "FEED" was added at the end');
  } else if (finalSymbol.length > MEME_SYMBOL_MAX) {
    finalSymbol = finalSymbol.slice(0, MEME_SYMBOL_MAX);
    changed.push(`symbol: cut to ${MEME_SYMBOL_MAX} characters`);
  }

  // The description: one sentence on one line, published with the coin for good: no address, no link.
  const rawDescription = input.description ?? "";
  if (/[\r\n]/.test(rawDescription.trim())) return { ok: false, reason: "description-lines" };
  const description = fold(rawDescription);
  if (description === "") return { ok: false, reason: "description-empty" };
  if ([...description].length > MEME_DESCRIPTION_MAX) return { ok: false, reason: "description-too-long" };
  if (ADDRESS.test(description)) return { ok: false, reason: "description-address" };
  if (URL_LIKE.test(description)) return { ok: false, reason: "description-url" };
  if (description !== rawDescription.trim()) changed.push("description: spacing and invisible characters were tidied");

  return { ok: true, concept, name: finalName, symbol: finalSymbol, description, changed };
}

// --- the host's picture --------------------------------------------------------------------------------

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type HostPicture = { ok: true; path: string; bytes: Uint8Array; sha256: string; name: string } | { ok: false; why: string };

/**
 * The picture the host made for the meme (`--image <path>`), as the coordinator's ruling C9 takes it: a PNG of at
 * most 262,144 bytes (the pin route's limit, and the SDK uploads every picture as a PNG). Read at most one byte past
 * the limit. Anything else is a reason, never an error: the league creature stands in, and the card says why.
 */
export function hostPicture(given: string, cwd = process.cwd()): HostPicture {
  const path = isAbsolute(given) ? given : resolve(cwd, given);
  const name = basename(path);
  if (!existsSync(path)) return { ok: false, why: "there is no file at that path" };
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { ok: false, why: "it is not a file" };
    size = stat.size;
  } catch {
    return { ok: false, why: "it could not be read" };
  }
  if (size > AVATAR_MAX_BYTES) return { ok: false, why: `it is over ${AVATAR_MAX_BYTES.toLocaleString("en-US")} bytes` };
  const bytes = new Uint8Array(Math.min(size, AVATAR_MAX_BYTES + 1));
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, why: "it could not be read" };
  }
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, why: `it is over ${AVATAR_MAX_BYTES.toLocaleString("en-US")} bytes` };
  if (bytes.length < PNG.length || PNG.some((b, i) => bytes[i] !== b)) return { ok: false, why: `it is ${kindOf(bytes)}, not a PNG` };
  return { ok: true, path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), name };
}

/** What a file's first bytes say it is, for the notice. */
function kindOf(bytes: Uint8Array): string {
  const head = (n: number) => [...bytes.subarray(0, n)];
  if (head(3).join() === [0xff, 0xd8, 0xff].join()) return "a JPEG";
  if (String.fromCharCode(...head(4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "a WebP";
  if (String.fromCharCode(...head(4)) === "GIF8") return "a GIF";
  return "not a picture this agent can use";
}

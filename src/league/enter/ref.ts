/**
 * `FL enter --ref <code>` (task 975, addendum 12; the owner's ruling of 2026-10-25 14:4x): a tutorial's referral code,
 * sent with the Register message as the unsigned claim `ref` (the field the site's web referrals use: `?ref=`). The
 * code is the site's own form (its referral alphabet, 6–8 characters, case-folded: `src/lib/referral/code.ts`), or
 * the older raw form, a wallet address. Given bare, or inside the league page's pasted line, which carries it as
 * `?ref=<code>` (a link) or `ref: <code>`. Anything else is refused before anything is asked of the wallet.
 */

/** The site's referral alphabet (no 0, 1, I, O) and lengths. */
export const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE = new RegExp(`^[${REF_ALPHABET}]{6,8}$`);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const REF_PROBLEM = "--ref is a referral code (6–8 letters and digits, as in feast.meme's /r/<code> links) or a wallet address, given alone or in the pasted line as ?ref=<code> or ref: <code>";

/** The code out of what was given: a bare code, a link with `?ref=`, or a line with `ref: <code>`. */
function candidate(raw: string): string {
  const text = raw.trim();
  const query = /[?&]ref=([^&#\s"'<>)\]}]+)/i.exec(text);
  if (query) {
    try {
      return decodeURIComponent(query[1]!);
    } catch {
      return query[1]!;
    }
  }
  const labelled = /(?:^|[\s,;(（[{【])ref\s*[:：=]\s*([^\s,;.。，；)）\]}】"'<>]+)/i.exec(text);
  if (labelled) return labelled[1]!;
  return text;
}

export function parseRef(raw: string | undefined | null): { ok: true; ref: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw.trim() === "") return { ok: true, ref: null };
  const c = candidate(raw).trim();
  const folded = c.toUpperCase();
  if (CODE.test(folded)) return { ok: true, ref: folded };
  if (ADDRESS.test(c) && !/^0x0{40}$/i.test(c)) return { ok: true, ref: c.toLowerCase() };
  return { ok: false, reason: REF_PROBLEM };
}

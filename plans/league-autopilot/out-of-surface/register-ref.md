# Site patch: `ref` on `POST /api/league/register` (task 975, addendum 12)

**Why.** `FL enter --ref <code>` (league-v5.1) sends a tutorial's referral code with the Register body as `ref`. That is the field name the site's web referrals use (`?ref=`). The register route (`src/app/api/league/register/route.ts`, read on the deploy tree at 2c5a4edb) has no referral field: it ignores `ref` today, harmlessly. The patch below keeps it, first touch wins, as an unsigned claim like `xHandle`: it never refuses a registration. Not applied, not run: the coordinator applies site patches.

**What it records.** The code as the site normalises it (`normalizeReferralCode`: its alphabet, 6–8 characters, upper case), or a referrer address (`normalizeReferrer`); anything else is dropped. Recording it **does not credit the referrer's 10 % on chain**. That credit follows the trader wallet's on-chain referrer binding (`referrerOf`, set through `/api/v1/referral/bind`'s `bindWithSig`), which neither this patch nor the runtime does. See the report's open question.

## 1. Migration: `supabase/migrations/20261025150000_league_ref.sql`

```sql
-- A tutorial's referral code (or a referrer address) given at entry (task 975, addendum 12): an unsigned claim,
-- the first one kept. Additive and idempotent.
ALTER TABLE league_agents ADD COLUMN IF NOT EXISTS ref text NULL;
```

## 2. `src/lib/league/registry.ts`

```diff
-export type Formal = { season: number; agentId: string; bodyCoin: string | null; launchRank: number | null };
+export type Formal = { season: number; agentId: string; bodyCoin: string | null; launchRank: number | null; ref?: string | null };
@@ saveAgent
-       INSERT INTO LEAGUE_AGENTS (WALLET, NAME, NAME_KEY, STRATEGY, COPIES, ISSUED_AT, SCHEME, SIGNATURE, SEASON, AGENT_ID, BODY_COIN)
-       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10)
+       INSERT INTO LEAGUE_AGENTS (WALLET, NAME, NAME_KEY, STRATEGY, COPIES, ISSUED_AT, SCHEME, SIGNATURE, SEASON, AGENT_ID, BODY_COIN, REF)
+       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11)
@@ ON CONFLICT (WALLET) DO UPDATE SET …
               AGENT_ID = EXCLUDED.AGENT_ID,
+              REF = COALESCE(LEAGUE_AGENTS.REF, EXCLUDED.REF),
@@ the parameters
         formal.bodyCoin,
+        formal.ref ?? null,
       ],
```

## 3. `src/app/api/league/register/route.ts` (the one line that matters, and its import)

```diff
+import { normalizeReferralCode } from "@/lib/referral/code";
+import { normalizeReferrer } from "@/app/coin/[address]/links";
@@ POST, beside the saveAgent call
-  const saved = await saveAgent(fields, scheme as Scheme, signature, { season: seasonNumberFromEnv(), agentId: agentId.name, bodyCoin, launchRank });
+  const ref = typeof record.ref === "string" ? (normalizeReferralCode(record.ref) ?? normalizeReferrer(record.ref)) : null;
+  const saved = await saveAgent(fields, scheme as Scheme, signature, { season: seasonNumberFromEnv(), agentId: agentId.name, bodyCoin, launchRank, ref });
```

And in the header comment's POST shape: `…, bodyCoin?, xHandle?, ref? }` with "`ref`: an unsigned claim, a referral code or a referrer address from a tutorial link; the first one kept; never refuses".

## Test for the site lane

A POST with `ref: "h7kmq2"` keeps `H7KMQ2`; a second POST with another code keeps the first; `ref: "nope!"` registers and keeps nothing; no `ref` behaves as today.

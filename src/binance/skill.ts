/**
 * The keyless source: Binance's official Wallet Skill `binance-tokenized-securities-info`
 * (github.com/binance/binance-skills-hub, skills/binance-web3/), whose "RWA Dynamic V2"
 * call needs no API key. It answers for bStocks (`type: 3`) as well as Ondo tokens,
 * though the skill's own text says Ondo only.
 *
 * Used when the RWA Data API has no credentials, and labelled as what it is.
 */

export const SKILL_RWA_DYNAMIC_URL =
  "https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai";

/** The skill asks agents to identify themselves this way. */
export const SKILL_USER_AGENT = "binance-web3/1.1 (Skill)";

export type SkillRwaDynamic = {
  symbol: string;
  ticker: string;
  /** 1 = Ondo, 2 = xStocks-style, 3 = bStock. */
  type: number | null;
  /** On-chain token price, USD, per token. */
  tokenPriceUsd: number | null;
  /** The listed share's price, USD; null outside US trading hours. */
  stockPriceUsd: number | null;
  /** Shares one token represents. */
  sharesMultiplier: number | null;
  /** tokenPrice / sharesMultiplier: the share price the token implies. */
  impliedSharePriceUsd: number | null;
  /** (token / multiplier − stock) / stock, when the stock price is known. */
  gap: number | null;
  openState: boolean | null;
  reasonCode: string | null;
};

type Raw = {
  code?: string;
  message?: string | null;
  success?: boolean;
  data?: {
    symbol?: string;
    ticker?: string;
    type?: number;
    tokenInfo?: { price?: string | null; sharesMultiplier?: string | null } | null;
    stockInfo?: { price?: string | null } | null;
    statusInfo?: { openState?: boolean | null; reasonCode?: string | null } | null;
  } | null;
};

function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse the skill's response; null when it did not answer with data. */
export function parseSkillRwaDynamic(body: unknown): SkillRwaDynamic | null {
  const raw = body as Raw;
  if (!raw || raw.code !== "000000" || !raw.data) return null;
  const d = raw.data;
  const tokenPrice = num(d.tokenInfo?.price);
  const multiplier = num(d.tokenInfo?.sharesMultiplier);
  const stockPrice = num(d.stockInfo?.price);
  const implied = tokenPrice !== null && multiplier ? tokenPrice / multiplier : tokenPrice;
  return {
    symbol: d.symbol ?? "",
    ticker: d.ticker ?? "",
    type: d.type ?? null,
    tokenPriceUsd: tokenPrice,
    stockPriceUsd: stockPrice,
    sharesMultiplier: multiplier,
    impliedSharePriceUsd: implied,
    gap: implied !== null && stockPrice ? (implied - stockPrice) / stockPrice : null,
    openState: d.statusInfo?.openState ?? null,
    reasonCode: d.statusInfo?.reasonCode ?? null,
  };
}

export async function skillRwaDynamic(
  contractAddress: string,
  options: { chainId?: string; fetch?: typeof fetch } = {},
): Promise<SkillRwaDynamic | null> {
  const url = `${SKILL_RWA_DYNAMIC_URL}?chainId=${options.chainId ?? "56"}&contractAddress=${contractAddress.toLowerCase()}`;
  const response = await (options.fetch ?? fetch)(url, {
    headers: { "Accept-Encoding": "identity", "User-Agent": SKILL_USER_AGENT, accept: "application/json" },
  });
  if (!response.ok) return null;
  try {
    return parseSkillRwaDynamic(JSON.parse(await response.text()));
  } catch {
    return null;
  }
}

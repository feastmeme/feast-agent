import { formatUnits } from "viem";

/** A raw 18-decimal amount, trimmed to `digits` significant decimals, grouped by thousands. */
export function amount(raw: bigint, decimals = 18, maxFraction = 6): string {
  const text = formatUnits(raw, decimals);
  const [whole = "0", fraction = ""] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction) return grouped;
  if (whole === "0" || whole === "-0") {
    // Small numbers keep their first significant digits rather than rounding to zero.
    const lead = fraction.match(/^0*/)?.[0].length ?? 0;
    const kept = fraction.slice(0, Math.min(fraction.length, lead + 4)).replace(/0+$/, "");
    return kept ? `${grouped}.${kept}` : grouped;
  }
  const kept = fraction.slice(0, maxFraction).replace(/0+$/, "");
  return kept ? `${grouped}.${kept}` : grouped;
}

/** A number with `significant` significant digits, never in exponent notation. */
export function sig(value: number, significant = 4): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1) {
    return value.toLocaleString("en-US", { maximumFractionDigits: Math.max(0, significant - Math.floor(Math.log10(abs)) - 1) });
  }
  const decimals = Math.min(20, significant - Math.floor(Math.log10(abs)) - 1);
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

export function usd(value: number | null | undefined, significant = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `$${sig(value, significant)}`;
}

export function pct(fraction: number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "n/a";
  const sign = fraction > 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(digits)}%`;
}

/** A GitHub-flavoured markdown table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  return [line(headers), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...rows.map(line)].join("\n");
}

/** JSON with bigints as decimal strings. */
export function json(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

import { describe, expect, it } from "vitest";

import { amount, json, pct, sig, table, usd } from "./format.ts";

describe("format", () => {
  it("prints raw 18-decimal amounts readably, keeping small ones significant", () => {
    expect(amount(1_234_567_890_000_000_000_000n)).toBe("1,234.56789");
    expect(amount(4_880_764_424_552_342n)).toBe("0.00488");
    expect(amount(10n ** 18n)).toBe("1");
    expect(amount(0n)).toBe("0");
  });
  it("never uses exponent notation for prices", () => {
    expect(sig(7.087418397e-9)).toBe("0.000000007087");
    expect(sig(326.33426)).toBe("326.3");
    expect(usd(0.0000016)).toBe("$0.0000016");
    expect(usd(null)).toBe("n/a");
  });
  it("signs percentages", () => {
    expect(pct(0.005)).toBe("+0.50%");
    expect(pct(-0.01)).toBe("-1.00%");
    expect(pct(null)).toBe("n/a");
  });
  it("renders a markdown table and bigint JSON", () => {
    expect(table(["a", "bb"], [["1", "2"]])).toBe("| a | bb |\n| - | -- |\n| 1 | 2  |");
    expect(json({ x: 1n })).toBe('{\n  "x": "1"\n}');
  });
});

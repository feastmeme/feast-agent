import { PRESETS, PRESET_IDS, type ParamSpec } from "./specs.ts";

/**
 * `skills/feast-league/references/presets.md`, generated from the specs the
 * runtime validates against, so the skill's tables can never drift from them
 * (presets.test.ts holds the file to this).
 */

const range = (p: ParamSpec): string => {
  switch (p.kind) {
    case "number": {
      const max = typeof p.max === "number" ? String(p.max) : p.max;
      return `${p.min} – ${max}${p.unit ? ` ${p.unit}` : ""}`;
    }
    case "optional-number":
      return `off, or ${p.min} – ${p.max}${p.unit ? ` ${p.unit}` : ""}`;
    case "boolean":
      return "true / false";
    case "enum":
      return p.options.join(" / ");
    case "addresses":
      return `${p.min} – ${p.max} wallets`;
    case "text":
      return `text, ≤ ${p.maxLength}`;
    case "quotes":
      return "all, or a list";
  }
};

const def = (p: ParamSpec): string => (p.default === null ? (p.kind === "optional-number" ? "off" : "asked") : String(p.default));

export function presetsMarkdown(): string {
  const out: string[] = [
    "# The six presets",
    "",
    "Generated from the runtime's own specs (`src/league/presets/specs.ts`); a test holds this file to them.",
    "Every size is bounded by L3 (the cap on BNB at work), every stop-loss by L6, every slippage by L9, every position count by L5.",
    "",
  ];
  for (const id of PRESET_IDS) {
    const spec = PRESETS[id];
    out.push(`## \`${id}\`: ${spec.title}`, "", `It ${spec.does}. Tick ${spec.tickSeconds} s${spec.events.length ? `; events: ${spec.events.join(", ")}` : ""}.`, "");
    out.push("| Parameter | Default | Range | Meaning |", "| --- | --- | --- | --- |");
    for (const p of spec.params) out.push(`| \`${p.key}\` | ${def(p)} | ${range(p)} | ${p.meaning} |`);
    out.push("");
  }
  return out.join("\n");
}

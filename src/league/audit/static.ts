/** The audit's static rules (PLAN.md §5.3). Stub: the implementation lands after the red tests. */
export type RuleId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9";
export type AuditHit = { rule: RuleId; line: number; column: number; message: string; severity: "refuse" | "warn" };
export type StaticAudit = { sha256: string; verdict: "pass" | "refuse"; hits: AuditHit[]; bytes: number; exports: string[]; tickSeconds: number | null };
export const AUDIT_RULES: readonly { id: RuleId; rule: string }[] = [];
export function auditSource(_source: string, _options: { maxTradeBnb?: number } = {}): StaticAudit {
  throw new Error("not implemented");
}
export function sha256Of(_source: string): string {
  throw new Error("not implemented");
}

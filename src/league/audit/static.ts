import { createHash } from "node:crypto";
import { parse } from "acorn";

/**
 * The audit's static rules (PLAN.md §5.3): deterministic, from the syntax tree.
 *
 * A user's strategy script is one ES module that gets everything through the
 * runtime's `api` and nothing else, so the rules can be strict: no imports, no
 * process, no network, no dynamic code, no unbounded loops, only the runtime's
 * functions. Strings are folded before they are read (`"ba" + "w"` is `baw`),
 * computed keys are read like property names, and an identifier spelled with an
 * escape is refused outright.
 *
 * This file only reads the script as text: it never imports, evaluates or runs
 * it. A pass here is the first of two; the second is a model read by the user's
 * own agent, against `skills/feast-audit/references/checklist.md`.
 */

export type RuleId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9";
export type AuditHit = { rule: RuleId; line: number; column: number; message: string; severity: "refuse" | "warn" };
export type StaticAudit = { sha256: string; verdict: "pass" | "refuse"; hits: AuditHit[]; bytes: number; exports: string[]; tickSeconds: number | null };

export const AUDIT_RULES: readonly { id: RuleId; rule: string }[] = [
  { id: "A1", rule: "No direct wallet or process access" },
  { id: "A2", rule: "No imports of any kind" },
  { id: "A3", rule: "No network beyond our endpoints" },
  { id: "A4", rule: "No secrets" },
  { id: "A5", rule: "No dynamic code, no reaching for globals" },
  { id: "A6", rule: "Bounded loops, no timers" },
  { id: "A7", rule: "Shape: named exports meta, params, onTick, onEvent; a tick of 15–3600 s; declarations only at the top; at most 64 KB; ASCII identifiers" },
  { id: "A8", rule: "Only the runtime's functions: api.buy, api.sell, api.launch, api.read.*, api.state, api.params, api.log" },
  { id: "A9", rule: "Literal sizes above the per-trade limit (a warning: the runtime refuses those trades anyway)" },
];

export const MAX_SCRIPT_BYTES = 64 * 1024;

const A1_IDENT = new Set(["baw", "child_process", "process", "worker_threads", "Worker", "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "Deno", "Bun", "cluster"]);
const A1_PROP = new Set(["process", "child_process", "worker_threads", "mainModule", "binding", "dlopen", "spawn", "spawnSync", "execSync", "execFile", "execFileSync", "baw"]);
const A1_STRING_WORD = /\b(baw|child_process|worker_threads)\b/;
const A1_STRING_EXACT = new Set(["process", "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "mainModule", "binding", "dlopen"]);

const A2_IDENT = new Set(["require", "importScripts"]);

const A3_IDENT = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "net", "http", "https", "http2", "dgram", "tls", "dns", "RTCPeerConnection", "sendBeacon", "Request", "Response"]);
const A3_PROP = new Set(["fetch", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource"]);
const URL_IN_TEXT = /\b(?:https?|wss?|ftp):\/\/([^\s/"'`?#:]+)/gi;
const OUR_HOSTS = /^(?:[a-z0-9-]+\.)*feast\.meme$/i;

const A4_IDENT = /^(?:private_?key|mnemonic|seed_?phrase|secret_?key|api_?secret|keystore)$/i;
const A4_HEX = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const A4_API_KEY = /(?:\bsk-[A-Za-z0-9_-]{8,}|\bsk_live_|\bAKIA[0-9A-Z]{12,}|\bghp_[A-Za-z0-9]{20,}|\bxox[abprs]-|\bAIza[0-9A-Za-z_-]{20,})/;
const A4_PATH = /(?:^|[\s/\\"'])\.env\b|\.ssh\b|\bid_rsa\b|\.pem\b|\bkeystore\b|PRIVATE_KEY/i;

const A5_IDENT = new Set(["eval", "Function", "globalThis", "global", "self", "window", "Reflect", "WebAssembly", "Proxy", "SharedArrayBuffer", "Atomics", "vm", "atob", "btoa", "unescape", "escape", "decodeURI", "decodeURIComponent"]);
/** Primitives that build a string out of codes or encodings: a script has no use for them but to hide a word. */
const A5_STRING_BUILDERS = new Set(["fromCharCode", "fromCodePoint"]);
const A5_PROP = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "caller",
  "callee",
  "getPrototypeOf",
  "setPrototypeOf",
  "defineProperty",
  "defineProperties",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
]);
const A5_STRING_EXACT = new Set(["constructor", "prototype", "__proto__", "globalThis", "eval", "Function", "global"]);

const A6_TIMERS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "requestAnimationFrame", "requestIdleCallback"]);
const MAX_LOOP_BOUND = 1_000;

const EXPORTS = new Set(["meta", "params", "onTick", "onEvent"]);
const API_MEMBERS = new Set(["buy", "sell", "launch", "read", "state", "params", "log"]);
const READ_MEMBERS = new Set(["now", "balance", "limits", "warmup", "coins", "coin", "trades", "positions", "position", "holders", "launchesBy", "launched"]);

type Node = { type: string; start: number; end: number; loc?: { start: { line: number; column: number } }; [key: string]: unknown };

export function sha256Of(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const v of value) if (v && typeof v === "object" && typeof (v as Node).type === "string") out.push(v as Node);
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Node).type === "string") out.push(value as Node);
  }
  return out;
}

/** A string an expression is sure to be, folding `+` and template literals of literals; null when it depends on anything else. */
function fold(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal") return typeof node.value === "string" || typeof node.value === "number" ? String(node.value) : null;
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis as Node[];
    const expressions = node.expressions as Node[];
    let text = "";
    for (let i = 0; i < quasis.length; i += 1) {
      text += String((quasis[i]!.value as { cooked?: string }).cooked ?? "");
      if (i < expressions.length) {
        const part = fold(expressions[i]);
        if (part === null) return null;
        text += part;
      }
    }
    return text;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = fold(node.left as Node);
    const right = fold(node.right as Node);
    return left !== null && right !== null ? left + right : null;
  }
  // `["con", "structor"].join("")`: an array of literals joined by a literal.
  if (node.type === "CallExpression") {
    const callee = node.callee as Node;
    const args = node.arguments as Node[];
    if (callee.type === "MemberExpression" && !callee.computed && String((callee.property as Node).name) === "join" && (callee.object as Node).type === "ArrayExpression" && args.length <= 1) {
      const parts = ((callee.object as Node).elements as (Node | null)[]).map((e) => fold(e));
      const separator = args.length === 0 ? "," : fold(args[0]);
      return parts.every((p) => p !== null) && separator !== null ? parts.join(separator) : null;
    }
  }
  return null;
}

/**
 * A computed key the audit can read: a constant it folds, or a plain variable,
 * member or arithmetic of those (`rows[i + 1]`, `state.seen[r.coin]`). Anything
 * that builds a key at run time — a call, a ternary, a logical, a string joined
 * to a variable — is refused: the audit fails closed where it cannot see.
 */
function readableKey(node: Node): boolean {
  switch (node.type) {
    case "Literal":
    case "Identifier":
      return true;
    case "MemberExpression":
      return node.computed ? readableKey(node.property as Node) && readableKey(node.object as Node) : readableKey(node.object as Node);
    case "UnaryExpression":
      return ["-", "+"].includes(String(node.operator)) && readableKey(node.argument as Node);
    case "BinaryExpression": {
      if (!["+", "-", "*", "/", "%"].includes(String(node.operator))) return false;
      const isText = (n: Node) => (n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral";
      if (isText(node.left as Node) || isText(node.right as Node)) return fold(node) !== null;
      return readableKey(node.left as Node) && readableKey(node.right as Node);
    }
    case "TemplateLiteral":
    case "CallExpression":
      return fold(node) !== null;
    default:
      return false;
  }
}

export function auditSource(source: string, options: { maxTradeBnb?: number } = {}): StaticAudit {
  const hits: AuditHit[] = [];
  const bytes = Buffer.byteLength(source, "utf8");
  const sha256 = sha256Of(source);
  const at = (node: Node | null) => ({ line: node?.loc?.start.line ?? 1, column: (node?.loc?.start.column ?? 0) + 1 });
  const hit = (rule: RuleId, node: Node | null, message: string, severity: "refuse" | "warn" = "refuse") => {
    const where = at(node);
    if (!hits.some((h) => h.rule === rule && h.line === where.line && h.message === message)) hits.push({ rule, ...where, message, severity });
  };
  const done = (exports: string[], tickSeconds: number | null): StaticAudit => ({
    sha256,
    verdict: hits.some((h) => h.severity === "refuse") ? "refuse" : "pass",
    hits: hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)),
    bytes,
    exports,
    tickSeconds,
  });

  if (bytes > MAX_SCRIPT_BYTES) hit("A7", null, `the file is ${bytes} bytes; a script is at most ${MAX_SCRIPT_BYTES}`);

  let program: Node;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: false }) as unknown as Node;
  } catch (error) {
    const e = error as { loc?: { line: number; column: number }; message?: string };
    hits.push({ rule: "A7", line: e.loc?.line ?? 1, column: (e.loc?.column ?? 0) + 1, message: `the file does not parse: ${e.message ?? "syntax error"}`, severity: "refuse" });
    return done([], null);
  }

  // --- A7 shape: the top level and the exports -------------------------------------------
  const exports: string[] = [];
  let tickSeconds: number | null = null;
  const apiNames = new Set(["api"]);
  for (const statement of program.body as Node[]) {
    switch (statement.type) {
      case "ImportDeclaration":
        hit("A2", statement, "imports are not allowed: everything comes through api");
        break;
      case "ExportAllDeclaration":
        hit("A2", statement, "re-exports are imports: not allowed");
        break;
      case "ExportDefaultDeclaration":
        hit("A7", statement, "named exports only (meta, params, onTick, onEvent)");
        break;
      case "ExportNamedDeclaration": {
        if (statement.source) hit("A2", statement, "re-exports are imports: not allowed");
        const declaration = statement.declaration as Node | null;
        const names: { name: string; node: Node; init?: Node | null }[] = [];
        if (declaration?.type === "FunctionDeclaration") names.push({ name: String((declaration.id as Node).name), node: declaration, init: declaration });
        else if (declaration?.type === "VariableDeclaration") {
          for (const d of declaration.declarations as Node[]) if ((d.id as Node).type === "Identifier") names.push({ name: String((d.id as Node).name), node: d, init: d.init as Node | null });
        } else if (declaration?.type === "ClassDeclaration") names.push({ name: String((declaration.id as Node).name), node: declaration });
        for (const s of (statement.specifiers as Node[]) ?? []) names.push({ name: String((s.exported as Node).name ?? (s.exported as Node).value), node: s });
        for (const { name, node, init } of names) {
          exports.push(name);
          if (!EXPORTS.has(name)) hit("A7", node, `"${name}" is not an export a script may have (meta, params, onTick, onEvent)`);
          if ((name === "onTick" || name === "onEvent") && init) {
            const fn = init.type === "FunctionDeclaration" || init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression" ? init : null;
            const first = fn ? ((fn.params as Node[])[0] ?? null) : null;
            if (first?.type === "Identifier") apiNames.add(String(first.name));
          }
          if (name === "meta" && init?.type === "ObjectExpression") {
            for (const p of init.properties as Node[]) {
              const key = (p.key as Node | undefined)?.name ?? (p.key as Node | undefined)?.value;
              if (key !== "tickSeconds") continue;
              const value = p.value as Node;
              if (value.type === "Literal" && typeof value.value === "number") {
                tickSeconds = value.value;
                if (value.value < 15 || value.value > 3_600) hit("A7", value, `meta.tickSeconds ${value.value} is outside 15–3600`);
              } else hit("A7", value, "meta.tickSeconds must be a number written out");
            }
          }
        }
        break;
      }
      case "FunctionDeclaration":
      case "VariableDeclaration":
      case "ClassDeclaration":
      case "EmptyStatement":
        break;
      default:
        hit("A7", statement, `a ${statement.type} at the top level runs on load: only declarations belong there`);
    }
  }
  if (!exports.includes("meta")) hit("A7", null, "the script must export meta");
  if (!exports.includes("onTick") && !exports.includes("onEvent")) hit("A7", null, "the script must export onTick or onEvent");

  // --- every node ---------------------------------------------------------------------------
  const checkString = (text: string, node: Node) => {
    if (A1_STRING_WORD.test(text) || A1_STRING_EXACT.has(text.trim())) hit("A1", node, `the text "${text.slice(0, 60)}" reaches for the wallet or the process`);
    if (A5_STRING_EXACT.has(text.trim())) hit("A5", node, `the text "${text}" names a global or a prototype`);
    if (["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "sendBeacon"].includes(text.trim())) hit("A3", node, `the text "${text}" names a network primitive`);
    if (["child_process", "fs", "node:fs", "net", "node:net", "http", "https", "node:http", "node:https", "node:child_process", "worker_threads"].includes(text.trim()) && !A1_STRING_WORD.test(text)) {
      hit("A2", node, `the text "${text}" names a module`);
    }
    for (const match of text.matchAll(URL_IN_TEXT)) {
      if (!OUR_HOSTS.test(match[1] ?? "")) hit("A3", node, `a URL to ${match[1]}: scripts reach no host but ours, and only through api.read`);
    }
    if (A4_HEX.test(text)) hit("A4", node, "a private-key-shaped hex string");
    if (A4_API_KEY.test(text)) hit("A4", node, "an API-key-shaped string");
    if (A4_PATH.test(text)) hit("A4", node, "a secret's path or name");
    const words = text.trim().split(/\s+/);
    if (words.length >= 12 && words.every((w) => /^[a-z]{3,8}$/.test(w))) hit("A4", node, "a seed-phrase-shaped run of words");
  };
  const checkIdentifier = (name: string, node: Node) => {
    if (/[^\x00-\x7F]/.test(name)) hit("A7", node, "identifiers are ASCII");
    if (source.slice(node.start, node.end) !== name) hit("A7", node, `the identifier "${name}" is spelled with an escape`);
    if (A1_IDENT.has(name)) hit("A1", node, `"${name}" reaches for the wallet or the process`);
    if (A2_IDENT.has(name)) hit("A2", node, `"${name}" imports: not allowed`);
    if (A3_IDENT.has(name)) hit("A3", node, `"${name}" is a network primitive`);
    if (A4_IDENT.test(name)) hit("A4", node, `"${name}" names a secret`);
    if (A5_IDENT.has(name)) hit("A5", node, `"${name}" is dynamic code or a global`);
    if (A6_TIMERS.has(name)) hit("A6", node, `"${name}": the runtime owns the cadence; no timers`);
  };
  const checkProperty = (name: string, node: Node) => {
    if (A1_PROP.has(name)) hit("A1", node, `".${name}" reaches for the wallet or the process`);
    if (A3_PROP.has(name)) hit("A3", node, `".${name}" is a network primitive`);
    if (A5_PROP.has(name)) hit("A5", node, `".${name}" reaches along the prototype chain`);
    if (A5_STRING_BUILDERS.has(name)) hit("A5", node, `".${name}" builds a string out of codes: not allowed`);
  };
  const isApi = (node: Node | undefined) => node?.type === "Identifier" && apiNames.has(String(node.name));

  const visit = (node: Node, parent: Node | null) => {
    switch (node.type) {
      case "Identifier": {
        const name = String(node.name);
        // A non-computed member's property and an object literal's key are names, not variables.
        const isMemberProperty = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
        const isKey = parent?.type === "Property" && parent.key === node && !parent.computed;
        if (isMemberProperty) checkProperty(name, node);
        else if (isKey) {
          // An object's or a destructuring pattern's key is a property name: `{ constructor: c } = x` reaches as `x.constructor` does.
          checkProperty(name, node);
          if (/[^\x00-\x7F]/.test(name) || source.slice(node.start, node.end) !== name) checkIdentifier(name, node);
        } else checkIdentifier(name, node);
        break;
      }
      case "Property": {
        const key = node.key as Node;
        if (node.computed) {
          const name = fold(key);
          if (name !== null) checkProperty(name, key);
          else if (!readableKey(key)) hit("A5", key, "a computed key the audit cannot read");
        } else if (key.type === "Literal" && typeof key.value === "string") checkProperty(key.value, key);
        break;
      }
      case "Literal":
        if (typeof node.value === "string") checkString(node.value, node);
        break;
      case "TemplateLiteral":
      case "BinaryExpression": {
        const text = fold(node);
        if (text !== null) checkString(text, node);
        break;
      }
      case "ImportExpression":
        hit("A2", node, "import() is an import: not allowed");
        break;
      case "MetaProperty":
        if ((node.meta as Node).name === "import") hit("A2", node, "import.meta is not available to scripts");
        break;
      case "WithStatement":
        hit("A5", node, "with is not allowed");
        break;
      case "WhileStatement":
        hit("A6", node, "while loops are not allowed: use for with a bound, or for…of");
        break;
      case "DoWhileStatement":
        hit("A6", node, "do…while loops are not allowed");
        break;
      case "ForStatement": {
        const test = node.test as Node | null;
        const bound = test?.type === "BinaryExpression" && ["<", "<=", ">", ">="].includes(String(test.operator)) ? [test.left as Node, test.right as Node].find((side) => side.type === "Literal" && typeof side.value === "number") : undefined;
        if (!bound) hit("A6", node, "a for loop needs a numeric literal bound in its test");
        else if (Number(bound.value) > MAX_LOOP_BOUND) hit("A6", node, `a loop bound of ${String(bound.value)} is above ${MAX_LOOP_BOUND}`);
        break;
      }
      case "MemberExpression": {
        const object = node.object as Node;
        const property = node.property as Node;
        const name = node.computed ? fold(property) : String(property.name);
        if (node.computed && name !== null) checkProperty(name, property);
        if (node.computed && name === null && !readableKey(property)) hit("A5", property, "a computed key the audit cannot read");
        if (!node.computed && object.type === "Identifier" && String(object.name) === "String" && name === "raw") hit("A5", node, "String.raw builds strings: not allowed");
        if (isApi(object)) {
          if (node.computed) hit("A8", node, "computed access on api is not allowed");
          else if (!API_MEMBERS.has(String(name))) hit("A8", node, `api.${name} is not one of the runtime's functions`);
        }
        if (object.type === "MemberExpression" && isApi(object.object as Node) && !object.computed && String((object.property as Node).name) === "read") {
          if (node.computed) hit("A8", node, "computed access on api.read is not allowed");
          else if (!READ_MEMBERS.has(String(name))) hit("A8", node, `api.read.${name} is not one of the runtime's reads`);
        }
        break;
      }
      case "VariableDeclarator": {
        const id = node.id as Node;
        const init = node.init as Node | null;
        if (id.type === "ObjectPattern" && init) {
          const fromApi = isApi(init);
          const fromRead = init.type === "MemberExpression" && isApi(init.object as Node) && String((init.property as Node).name) === "read";
          if (fromApi || fromRead) {
            for (const p of id.properties as Node[]) {
              if (p.type !== "Property" || p.computed) {
                hit("A8", p, "destructure api by name only");
                continue;
              }
              const key = String((p.key as Node).name ?? (p.key as Node).value);
              if (fromApi && !API_MEMBERS.has(key)) hit("A8", p, `api.${key} is not one of the runtime's functions`);
              if (fromRead && !READ_MEMBERS.has(key)) hit("A8", p, `api.read.${key} is not one of the runtime's reads`);
            }
          }
        }
        if (id.type === "Identifier" && init && (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression")) recursion(String(id.name), init);
        break;
      }
      case "FunctionDeclaration":
        if (node.id) recursion(String((node.id as Node).name), node);
        break;
      case "CallExpression": {
        const callee = node.callee as Node;
        const isBuy = callee.type === "MemberExpression" && isApi(callee.object as Node) && String((callee.property as Node).name) === "buy";
        const arg = (node.arguments as Node[])[0];
        if (isBuy && arg?.type === "ObjectExpression" && options.maxTradeBnb !== undefined) {
          for (const p of arg.properties as Node[]) {
            const key = (p.key as Node | undefined)?.name ?? (p.key as Node | undefined)?.value;
            const value = p.value as Node | undefined;
            if (key === "bnb" && value?.type === "Literal" && typeof value.value === "number" && value.value > options.maxTradeBnb) {
              hit("A9", value, `a buy of ${value.value} BNB is above the per-trade limit of ${options.maxTradeBnb} BNB; the runtime will refuse it`, "warn");
            }
          }
        }
        break;
      }
    }
    for (const child of children(node)) visit(child, node);
  };

  /** A function that calls itself by name, directly. */
  const recursion = (name: string, fn: Node) => {
    const search = (node: Node): boolean => {
      if (node.type === "CallExpression" && (node.callee as Node).type === "Identifier" && String((node.callee as Node).name) === name) return true;
      return children(node).some(search);
    };
    if (search(fn.body as Node)) hit("A6", fn, `"${name}" calls itself: recursion is not allowed`);
  };

  visit(program, null);
  return done(exports, tickSeconds);
}

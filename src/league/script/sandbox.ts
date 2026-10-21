import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { IntentRequest, Meta } from "../strategy.ts";

/**
 * The script sandbox, the parent's side (PLAN.md §5.2): one child process per
 * running script, under Node's permission model with an empty environment.
 * The static audit is the gate; this is the boundary.
 */

export const HARNESS = fileURLToPath(new URL("./harness.mjs", import.meta.url));

export type CallResult = { ok: true; requests: IntentRequest[]; logs: string[]; state: Record<string, unknown> } | { ok: false; error: string };

type Pending = { resolve: (value: CallResult) => void; timer: NodeJS.Timeout };

export class ScriptSandbox {
  private pending = new Map<number, Pending>();
  private next = 1;
  private exited: string | null = null;

  private constructor(
    private readonly child: ChildProcess,
    readonly meta: Meta,
    readonly params: Record<string, unknown>,
    readonly exports: string[],
  ) {
    child.on("message", (message: { type?: string; id?: number; result?: string; error?: string }) => {
      if (typeof message?.id !== "number") return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.type === "result" && typeof message.result === "string") {
        try {
          const parsed = JSON.parse(message.result) as { requests?: IntentRequest[]; logs?: string[]; state?: Record<string, unknown> };
          waiting.resolve({ ok: true, requests: Array.isArray(parsed.requests) ? parsed.requests : [], logs: Array.isArray(parsed.logs) ? parsed.logs : [], state: parsed.state ?? {} });
        } catch {
          waiting.resolve({ ok: false, error: "the script answered something that is not JSON" });
        }
      } else waiting.resolve({ ok: false, error: message.error ?? "the script failed" });
    });
    child.on("exit", (code, signal) => {
      this.exited = `the sandbox exited (${signal ?? code})`;
      for (const [, waiting] of this.pending) {
        clearTimeout(waiting.timer);
        waiting.resolve({ ok: false, error: this.exited });
      }
      this.pending.clear();
    });
  }

  /** The argv the child runs with: everything the script is denied is denied here. */
  static execArgv(): string[] {
    return [
      "--permission",
      `--allow-fs-read=${HARNESS}`,
      "--disallow-code-generation-from-strings",
      "--experimental-vm-modules",
      "--max-old-space-size=128",
      "--no-warnings",
    ];
  }

  static async start(source: string, timeoutMs = 5_000): Promise<ScriptSandbox> {
    const child = fork(HARNESS, [], { execArgv: ScriptSandbox.execArgv(), env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json" });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8");
    });
    const loaded = await new Promise<{ meta: Meta; params: Record<string, unknown>; exports: string[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("the script did not load in time"));
      }, timeoutMs);
      child.on("message", (message: { type?: string; meta?: Meta; params?: Record<string, unknown>; exports?: string[]; error?: string; id?: unknown }) => {
        if (message?.type === "ready") child.send({ type: "load", source });
        else if (message?.type === "loaded") {
          clearTimeout(timer);
          resolve({ meta: message.meta!, params: message.params ?? {}, exports: message.exports ?? [] });
        } else if (message?.type === "error" && message.id === null) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error(`the script did not load: ${message.error}`));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the sandbox exited while loading (${code})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`));
      });
    });
    return new ScriptSandbox(child, loaded.meta, loaded.params, loaded.exports);
  }

  /** One call, bounded twice: the vm's timeout inside, and a kill outside if the child stops answering. */
  call(fn: "onTick" | "onEvent", input: { snapshot: unknown; state: Record<string, unknown>; params: Record<string, unknown>; event?: unknown }, timeoutMs: number): Promise<CallResult> {
    if (this.exited) return Promise.resolve({ ok: false, error: this.exited });
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `the script overran ${timeoutMs} ms and was stopped` });
        this.child.kill("SIGKILL");
      }, timeoutMs + 2_000);
      this.pending.set(id, { resolve, timer });
      this.child.send({ type: "call", id, fn, timeoutMs, input: JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
    });
  }

  stop(): void {
    if (!this.exited) this.child.kill("SIGKILL");
  }

  get alive(): boolean {
    return this.exited === null;
  }
}

#!/usr/bin/env node
// `feast-league …`: run the TypeScript CLI through tsx, no build step.
import { register } from "tsx/esm/api";

register();
await import("./cli.ts");

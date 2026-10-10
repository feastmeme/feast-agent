#!/usr/bin/env node
// `npx feast-agent …` after `npm install`: run the TypeScript CLI through tsx, no build step.
import { register } from "tsx/esm/api";

register();
await import("./cli.ts");

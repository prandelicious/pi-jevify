import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Trace } from "./types.js";
/** Deliberately logs metrics only: no task text, credentials, payload bodies or tool arguments. */
export function jsonlSink(path: string): (trace: Trace) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (trace) =>
    appendFileSync(path, `${JSON.stringify(trace)}\n`, { mode: 0o600 });
}

import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { EvalCase } from "./corpus.js";
/** Restore supplied checker fixtures before validation so agent edits cannot weaken them. */
export function checkArtifacts(c: EvalCase, cwd: string): boolean {
  if (!c.checks.command) return true;
  const [command, ...args] = c.checks.command;
  for (const arg of c.checks.checkerFiles ?? []) {
    const original = c.files?.[arg];
    if (original === undefined)
      throw new Error("Missing immutable checker fixture");
    const path = resolve(cwd, arg);
    if (!path.startsWith(cwd + "/"))
      throw new Error("Checker path escapes workspace");
    rmSync(path, { force: true }); // Unlink an agent-created symlink before writing the original checker.
    writeFileSync(path, original);
  }
  const checkerEnv = { ...process.env };
  delete checkerEnv.NODE_TEST_CONTEXT;
  return (
    spawnSync(command!, args, {
      cwd,
      timeout: 15000,
      encoding: "utf8",
      env: checkerEnv,
    }).status === 0
  );
}

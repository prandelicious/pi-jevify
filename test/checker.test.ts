import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkArtifacts } from "../evals/checker.js";
import { loadCorpus } from "../evals/corpus.js";
test("changing the workspace test does not let a broken artifact pass", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jevify-check-"));
  try {
    const c = loadCorpus().find((c) => c.id === "core-edit")!;
    writeFileSync(join(root, "math.mjs"), c.files!["math.mjs"]!);
    writeFileSync(join(root, "math.test.mjs"), "// all tests removed\n");
    assert.equal(checkArtifacts(c, root), false);
    writeFileSync(
      join(root, "math.mjs"),
      "export const double = x => x * 2;\n",
    );
    assert.equal(checkArtifacts(c, root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("custom named checkers and helper fixtures are restored", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jevify-check-custom-"));
  try {
    const c = {
      id: "custom",
      category: "core",
      prompt: "fix artifact",
      labels: {
        required: [],
        required_any: [],
        optional: [],
        irrelevant: [],
        expected_skills: [],
      },
      files: {
        "verify.mjs":
          "import {ok} from './checker-helper.mjs'; process.exit(ok?0:1);",
        "checker-helper.mjs": "export const ok=false;",
      },
      checks: {
        command: ["node", "verify.mjs"],
        checkerFiles: ["verify.mjs", "checker-helper.mjs"],
      },
    };
    writeFileSync(join(root, "verify.mjs"), "");
    writeFileSync(join(root, "checker-helper.mjs"), "export const ok=true;");
    assert.equal(checkArtifacts(c, root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

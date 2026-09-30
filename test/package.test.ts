import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
test("installable entry loads through Pi own TypeScript extension loader", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jevify-load-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [resolve("src/index.ts")],
    });
    await loader.reload();
    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    assert.equal(extensions.extensions.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

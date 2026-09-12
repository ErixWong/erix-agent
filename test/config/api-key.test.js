import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveApiKey } from "../../src/config/api-key.js";

test("resolves direct, environment, and trimmed file keys in precedence order", async () => {
  const envName = `ERIX_LLM_KIT_KEY_${process.pid}`;
  const directory = await mkdtemp(join(tmpdir(), "erix-llm-kit-"));
  const file = join(directory, "api-key");
  const previous = process.env[envName];

  try {
    await writeFile(file, "  file-secret \n", "utf8");
    process.env[envName] = "env-secret";

    assert.equal(
      await resolveApiKey({ apiKey: "direct-secret", apiKeyEnv: envName, apiKeyFile: file }),
      "direct-secret",
    );
    assert.equal(await resolveApiKey({ apiKeyEnv: envName, apiKeyFile: file }), "env-secret");

    delete process.env[envName];
    assert.equal(await resolveApiKey({ apiKeyFile: file }), "file-secret");
    assert.equal(await resolveApiKey({}), undefined);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("apiKeyFile validates paths and warns without rejecting readable files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "erix-llm-kit-api-key-validation-"));
  const file = join(directory, "api-key");
  const originalError = console.error;
  const warnings = [];
  try {
    await writeFile(file, "file-secret\n", "utf8");
    await chmod(file, 0o644);
    console.error = (message) => warnings.push(String(message));
    assert.equal(await resolveApiKey({ apiKeyFile: file }), "file-secret");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /group\/other/);

    await assert.rejects(resolveApiKey({ apiKeyFile: "" }), {
      name: "TypeError",
    });
    const directoryPath = join(directory, "not-a-file");
    await mkdir(directoryPath);
    await assert.rejects(resolveApiKey({ apiKeyFile: directoryPath }), {
      name: "TypeError",
    });
  } finally {
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

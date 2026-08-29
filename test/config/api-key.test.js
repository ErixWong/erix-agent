import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

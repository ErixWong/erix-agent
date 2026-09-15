import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileResourceStore } from "../../src/store/resource-file.js";
import { resourceStoreContract } from "./resource-store.js";

resourceStoreContract("file resource", async () => (
  createFileResourceStore({
    dir: await mkdtemp(join(tmpdir(), "erix-resource-contract-")),
  })
));

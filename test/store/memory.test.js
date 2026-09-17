import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { transcriptStoreContract } from "../contract/transcript-store.js";
import { recallContract } from "../contract/recall-contract.js";

// memory store：通用行为全部由契约套件覆盖，无实现特有行为需补充
transcriptStoreContract("memory", () => createMemoryTranscriptStore());
recallContract("memory", () => createMemoryTranscriptStore());

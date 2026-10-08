import { terminationPayloadContract } from "./termination-payload.js";

// 库内置参考实现：从包入口（src/index.js）取 runToolLoop 跑同一契约（issue #176 / #180）。
terminationPayloadContract("reference", async () => await import("../../src/index.js"));

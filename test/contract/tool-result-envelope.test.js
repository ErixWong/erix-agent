// 工具事实信封契约套件的仓内参考跑法（与 `check:release` 通过安装好的包跑的是同一份断言）。
import { toolResultEnvelopeContract } from "./tool-result-envelope.js";

toolResultEnvelopeContract("reference", async () => await import("../../src/index.js"));

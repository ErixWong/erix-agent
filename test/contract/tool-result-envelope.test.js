// 工具事实信封契约套件的仓内参考跑法（原 `check:release` 通过安装好的包跑的是同一份断言，该闸已删）。
import { toolResultEnvelopeContract } from "./tool-result-envelope.js";

toolResultEnvelopeContract("reference", async () => await import("../../src/index.js"));

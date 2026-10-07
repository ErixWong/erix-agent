import { engineApiContract } from "./engine-api.js";

// 库内置参考实现：从包入口（src/index.js）取新 API 跑同一契约。
engineApiContract("reference", async () => await import("../../src/index.js"));

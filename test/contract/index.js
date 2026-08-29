// 契约测试套件公共导出（package.json "./contract-tests" 子路径）
// 项目侧 DB 适配器（app_container PG / touwaka MariaDB）写完跑本套件全绿即接口兼容。
export { transcriptStoreContract } from "./transcript-store.js";
export { modelConfigProviderContract } from "./model-config-provider.js";

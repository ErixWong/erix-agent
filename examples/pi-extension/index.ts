/**
 * pi 扩展目录入口：把整个 examples/pi-extension 目录装成一条扩展时，pi 读的是这个 index.ts
 * （docs/extensions.md：「Pi loads direct TypeScript or JavaScript files and subdirectories
 * containing an index.ts or index.js entry point」）。
 *
 * 两种装法都支持（README 有步骤）：
 *   - 目录整体：~/.pi/agent/extensions/erix-run/（本文件为入口，erix-run.ts + erix-run-core.js 同级）
 *   - 单文件开发态：pi --extension ./examples/pi-extension/erix-run.ts
 */

export { default } from "./erix-run.ts";

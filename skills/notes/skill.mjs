// 兼容层（供旧 discovery 路径与第三方 skill 加载器使用）；规范实现与全套装配工厂位于
// src/tools/notes.js（createBuiltinNotesTools）。CLI 自身已通过工厂装配 notes，
// bundled skill 始终被排除；本薄壳的未来退役由版本策略决定。
export * from "../../src/tools/notes.js";

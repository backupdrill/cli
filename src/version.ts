import { createRequire } from "node:module";

// npm_package_version 只在 npm scripts 环境里存在;全局安装 / npx 场景必须
// 从包内 package.json 读,否则 --version 与 manifest.toolVersion 永远是旧值。
export const TOOL_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

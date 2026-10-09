// issue #185：测试临时目录的路径卫生。
//
// 规矩只有一条：临时目录一律从 `os.tmpdir()` 取（尊重 TMPDIR），不在源码里焊死 `/tmp`。
// 只读 `/tmp` 的环境（容器 `--tmpfs /tmp:ro`、CI 沙箱）里，写死 `/tmp` 的 mkdtemp 会 EROFS，
// 一整批用例会以「与产品无关」的原因失败。
//
// 本模块**不在加载期创建任何目录**：目录只在 `makeTmp()` 被调用时才落盘，
// 避免 import 副作用与并行用例互相干扰。
import { after } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 在 `os.tmpdir()` 下创建一个唯一临时目录，并注册用例结束后的清理。
 *
 * 清理是尽力而为且幂等的：调用方原有的 `finally { rm(...) }` 可以保留，
 * `force: true` 让「已删除」不构成错误。
 *
 * @param {string} prefix 目录名前缀（保持可读，便于排查残留）
 * @returns {Promise<string>} 新建目录的绝对路径
 */
export async function makeTmp(prefix) {
  const base = tmpdir();
  // TMPDIR 指向尚未存在的目录时兜底建一层父目录；已存在则是 no-op。
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, prefix));
  after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

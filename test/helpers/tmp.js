// issue #185 / #199：测试临时目录的路径卫生与可写性探针。
//
// 规矩只有一条：临时目录一律从 `os.tmpdir()` 取（尊重 TMPDIR），不在源码里焊死 `/tmp`。
// 只读 `/tmp` 的环境（容器 `--tmpfs /tmp:ro`、CI 沙箱）里，写死 `/tmp` 的 mkdtemp 会 EROFS，
// 一整批用例会以「与产品无关」的原因失败。
//
// issue #199 追加两件事：
// 1. **可写探针**：`os.tmpdir()` 的解析序是 `TMPDIR → TMP → TEMP → TMP → '/tmp'`，会静默回落
//    `/tmp`。基路径不可写时（TMPDIR 指错、`/tmp` 只读且无可用 TMPDIR），首次 `makeTmp()` 就以
//    具名错误 `TMPDIR_NOT_WRITABLE` 失败——「一条根因」而不是「一片 EROFS」。
//    探针**进程内 memoize**：只在首次调用跑一次，成功即缓存，后续调用不再探测。
//    这里**不做** `t.skip()`（会把真缺陷一起掩盖），也**不静默回落** `/tmp` 或当前目录。
// 2. `mkdir(base, { recursive: true })` 兜底保留：`TMPDIR` 指向尚未存在的路径时先建出来，
//    建不出来才让探针抛具名错误。
//
// 本模块**不在加载期创建任何目录**：目录只在 `makeTmp()` 被调用时才落盘，
// 避免 import 副作用与并行用例互相干扰。探针同理挂在首次调用上。
import { after } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 进程内 memoize 的探针结果（Promise）。null = 尚未探测。 */
let probe = null;

async function runTmpDirProbe() {
  const base = tmpdir();
  try {
    // TMPDIR 指向尚未存在的目录时兜底建一层父目录；已存在则是 no-op。
    await mkdir(base, { recursive: true });
    // 建目录本身就是一次写盘试探；建得出来即视为可写。
    const dir = await mkdtemp(join(base, "erix-probe-"));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    const named = new Error(
      `TMPDIR_NOT_WRITABLE: 临时目录基路径不可写 — tmpdir() 当前取值为 ${JSON.stringify(base)}` +
      `（原始错误码：${err?.code ?? err?.name ?? String(err)}）。` +
      `建议：把 TMPDIR 指向一个可写目录，例如 mkdir -p ~/.tmp && TMPDIR=~/.tmp node --test。`
    );
    named.name = "TMPDIR_NOT_WRITABLE";
    named.code = "TMPDIR_NOT_WRITABLE";
    named.cause = err;
    throw named;
  }
}

/**
 * 在 `os.tmpdir()` 下创建一个唯一临时目录，并注册用例结束后的清理。
 *
 * 首次调用会先跑一次可写探针（memoize，见文件头注释）；基路径不可写时抛
 * `TMPDIR_NOT_WRITABLE` 具名错误，而不是让后续用例成片 EROFS/ENOENT。
 *
 * 清理是尽力而为且幂等的：调用方原有的 `finally { rm(...) }` 可以保留，
 * `force: true` 让「已删除」不构成错误。
 *
 * @param {string} prefix 目录名前缀（保持可读，便于排查残留）
 * @returns {Promise<string>} 新建目录的绝对路径
 */
export async function makeTmp(prefix) {
  probe ??= runTmpDirProbe();
  await probe;
  const base = tmpdir();
  // 兜底保留：进程中途 TMPDIR 被改到尚未存在的路径时，先建出来再 mkdtemp。
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, prefix));
  after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

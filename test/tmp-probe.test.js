// issue #199：钉住 makeTmp 可写探针的行为（实现见 test/helpers/tmp.js）。
//
// 「不可写」路径全部选**与 uid 无关**的形态：把 TMPDIR 指向「一个普通文件下的子路径」，
// mkdir/mkdtemp 必然 ENOTDIR——root 也绕不过去（不用 chmod 000 那种 root 可无视的形态）。
//
// 探针是**进程内按模块实例 memoize** 的一次性状态，所以每次要验证「首次调用探测」行为时，
// 用带 query 的动态 import 拿一份全新的 tmp.js 实例，避免与主实例（以及本文件其它用例）互串。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmp } from "./helpers/tmp.js";

let freshSeq = 0;
async function freshTmpHelper() {
  freshSeq += 1;
  return import(`./helpers/tmp.js?probe=${freshSeq}`);
}

// os.tmpdir() 的解析序是 TMPDIR → TMP → TEMP → TMP → '/tmp'，设 TMPDIR 即可整体接管。
async function withFakeTmpdir(value, fn) {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

test("makeTmp 探针：TMPDIR 指向普通文件下的路径时抛 TMPDIR_NOT_WRITABLE 具名错误（与 uid 无关，root 同样失败）", async () => {
  const fixture = await makeTmp("erix-probe-fixture-");
  const blocker = join(fixture, "blocker");
  await writeFile(blocker, "我是普通文件，不是目录");
  const fakeTmp = join(blocker, "sub-tmp");
  await withFakeTmpdir(fakeTmp, async () => {
    const fresh = await freshTmpHelper();
    let err;
    try {
      await fresh.makeTmp("erix-never-created-");
    } catch (e) {
      err = e;
    }
    assert.ok(err, "必须抛错，不许静默回落 /tmp 或当前目录，也不许 skip");
    assert.equal(err.name, "TMPDIR_NOT_WRITABLE");
    assert.equal(err.code, "TMPDIR_NOT_WRITABLE");
    assert.ok(err.message.includes(fakeTmp), "消息必须含 tmpdir() 当前取值");
    assert.match(err.message, /ENOTDIR/, "消息必须含原始错误码");
    assert.match(err.message, /TMPDIR/);
    assert.match(err.message, /可写/, "消息必须含可执行建议（把 TMPDIR 指向可写目录）");
    assert.equal(err.cause?.code, "ENOTDIR");
    // 失败结果同样被 memoize：同一实例后续调用复用**同一个**具名错误对象，不再重探。
    const again = await fresh.makeTmp("erix-never-created-again-").catch((e) => e);
    assert.equal(again, err, "探针必须一次性 memoize（重探会产生新 Error 对象）");
  });
});

test("makeTmp 探针：TMPDIR 指向不存在的目录时兜底建出来并正常返回（mkdir recursive 兜底保留）", async () => {
  const fixture = await makeTmp("erix-probe-deep-");
  const fakeTmp = join(fixture, "deep", "not-exist-yet");
  assert.equal(existsSync(fakeTmp), false);
  await withFakeTmpdir(fakeTmp, async () => {
    const fresh = await freshTmpHelper();
    const a = await fresh.makeTmp("erix-deep-ok-");
    const b = await fresh.makeTmp("erix-deep-ok-");
    assert.ok(a.startsWith(fakeTmp) && b.startsWith(fakeTmp));
    assert.notEqual(a, b, "每次调用必须拿到独立目录（探针成功不应吞后续调用）");
    assert.ok(existsSync(a) && existsSync(b));
  });
});

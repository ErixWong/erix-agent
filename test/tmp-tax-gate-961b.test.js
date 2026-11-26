import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { makeTmp } from './helpers/tmp.js';

// 反向证3：一个会写临时文件的新测试，**不登记任何白名单**（#961 B 已删掉 flat-count-inventory 家族，
// 新测试不必再往 compat-pin-allowlist 里登记）。只要 makeTmp 能用、写盘成功、清理不报错即可。
test('makeTmp 写临时文件（无白名单登记）⇒ 绿（#961 B 反向证3）', async () => {
  const dir = await makeTmp('erix-961b-taxgate-');
  const f = path.join(dir, 'probe.txt');
  await writeFile(f, 'written without any allowlist registration\n', 'utf8');
  const back = await readFile(f, 'utf8');
  assert.equal(back, 'written without any allowlist registration\n');
  await rm(dir, { recursive: true, force: true });
});

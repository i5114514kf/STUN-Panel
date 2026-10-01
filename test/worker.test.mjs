/**
 * STUN-Panel Worker 行为测试
 *
 * 跑法：node --test test/worker.test.mjs
 *
 * 仓库里没有 package.json，Node 会把 src/index.js 当 CommonJS，所以这里把源码
 * 通过 data: URL 当 ESM 导入（源码是自包含的，没有相对 import）。
 * Cloudflare 的 KV 用下面的 FakeKV 顶替，测试不碰网络。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
const worker = mod.default;

const KEY = '123456';
const ORIGIN = 'https://panel.example.com';

class FakeKV {
  constructor() { this.map = new Map(); }
  async put(key, value, options = {}) { this.map.set(key, { value, metadata: options.metadata ?? null }); }
  async get(key) { const e = this.map.get(key); return e ? e.value : null; }
  async getWithMetadata(key) {
    const e = this.map.get(key);
    return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null };
  }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '' } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

const newEnv = () => ({ LUCKY_STORE: new FakeKV() });
const call = (env, url, init) => worker.fetch(new Request(ORIGIN + url, init), env);
const report = (env, name, addr, key = KEY) =>
  call(env, '/?key=' + key + '&name=' + encodeURIComponent(name) + '&addr=' + encodeURIComponent(addr));
const panel = (env, key) => call(env, key ? '/?key=' + key : '/');
const post = (env, endpoint, name, key = KEY) =>
  call(env, endpoint + '?key=' + key + '&name=' + encodeURIComponent(name), { method: 'POST' });

const CARD = (name) => 'class="card-wrap service-card" data-name="' + name + '"';
const DEL_BTN = 'class="icon-btn del-btn"';

/* ---------- 上报与跳转（原有行为，不能坏） ---------- */

test('webhook 用错的 key 被拒', async () => {
  const env = newEnv();
  const res = await report(env, 'node1', '1.2.3.4:8080', 'wrong');
  assert.equal(res.status, 403);
  assert.equal(await env.LUCKY_STORE.get('SERVICE_node1'), null);
});

test('webhook 正常写入，返回串保持 Update Success 前缀（Lucky 靠它判断成功）', async () => {
  const env = newEnv();
  const res = await report(env, 'node1', '1.2.3.4:8080');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /^Update Success/);
  assert.equal(await env.LUCKY_STORE.get('SERVICE_node1'), '1.2.3.4:8080');
  const { metadata } = await env.LUCKY_STORE.getWithMetadata('SERVICE_node1');
  assert.ok(metadata.lastUpdate > 0);
});

// 注意：Response.redirect 会按 URL 规范补上尾斜杠，这是原版就有的行为，不是本次改动引入的
test('/<名字> 302 跳到节点地址', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  const res = await call(env, '/node1', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'http://1.2.3.4:8080/');
});

test('/<名字> 支持 URL 编码的中文节点名', async () => {
  const env = newEnv();
  await report(env, '客厅主机', '10.0.0.5:9000');
  const res = await call(env, '/' + encodeURIComponent('客厅主机'), { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'http://10.0.0.5:9000/');
});

test('已带 http:// 的地址不会被重复加前缀', async () => {
  const env = newEnv();
  await report(env, 'web', 'https://example.com:8443');
  const res = await call(env, '/web', { redirect: 'manual' });
  assert.equal(res.headers.get('location'), 'https://example.com:8443/');
});

/* ---------- 面板渲染 ---------- */

test('普通访问能看到卡片，但没有删除按钮、没有注入 KEY', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  const html = await (await panel(env)).text();
  assert.ok(html.includes(CARD('node1')), '应该有 node1 的卡片');
  assert.ok(html.includes('1.2.3.4:8080'));
  assert.ok(!html.includes(DEL_BTN), '非管理员不该有删除按钮');
  assert.ok(html.includes('const KEY = null;'), '非管理员 KEY 必须是 null');
  assert.ok(!html.includes('class="admin-area"'), '非管理员看不到已删除管理区');
});

test('管理员访问（URL 带 key）才渲染删除按钮、KEY 和管理区', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  const html = await (await panel(env, KEY)).text();
  assert.ok(html.includes(DEL_BTN));
  assert.ok(html.includes('const KEY = "123456";'));
  assert.ok(html.includes('class="admin-area"'));
  assert.ok(html.includes('已删除节点'));
  assert.ok(html.includes('autoCollapseToggle'));
  assert.ok(html.includes('card-link'));
});

test('节点名里的 HTML 会被转义（防 XSS）', async () => {
  const env = newEnv();
  const evil = '<img src=x onerror=alert(1)>';
  await report(env, evil, '1.2.3.4:8080');
  const html = await (await panel(env, KEY)).text();
  assert.ok(!html.includes('<img src=x'), '原始标签不能出现');
  assert.ok(html.includes('&lt;img src=x'), '应该被转义成实体');
});

test('KV 里没有地址记录的名字不渲染', async () => {
  const env = newEnv();
  await env.LUCKY_STORE.put('SERVICE_ghost', '');
  const html = await (await panel(env)).text();
  assert.ok(!html.includes(CARD('ghost')));
});

/* ---------- 功能 1：手动删除 ---------- */

test('删除接口：无 key 403、控制字符 400、GET 405', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  assert.equal((await call(env, '/api/delete?key=bad&name=node1', { method: 'POST' })).status, 403);
  assert.equal((await post(env, '/api/delete', 'bad\u0007name')).status, 400);
  assert.equal((await call(env, '/api/delete?key=' + KEY + '&name=node1')).status, 405);
  assert.equal(await env.LUCKY_STORE.get('SERVICE_node1'), '1.2.3.4:8080', '失败的删除不能动数据');
});

test('删除：数据挪到墓碑、面板不再显示卡片、管理区列出它', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  await report(env, 'node2', '5.6.7.8:80');

  const res = await post(env, '/api/delete', 'node1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, name: body.name, hadAddress: body.hadAddress },
    { ok: true, name: 'node1', hadAddress: true });
  assert.equal(await env.LUCKY_STORE.get('SERVICE_node1'), null, 'SERVICE_ 应该删掉');
  assert.equal(await env.LUCKY_STORE.get('HIDDEN_node1'), '1.2.3.4:8080', '墓碑里要留地址');

  const html = await (await panel(env, KEY)).text();
  assert.ok(!html.includes(CARD('node1')), 'node1 卡片不该在');
  assert.ok(html.includes(CARD('node2')), 'node2 卡片必须还在');
  assert.ok(html.includes('class="hidden-item" data-name="node1"'), '管理区要列出 node1');
  assert.ok(html.includes('id="hiddenCount">1<'), '计数应为 1');
});

test('删除后 Lucky 继续上报也不会复活（墓碑生效），且仍回 Update Success', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  await post(env, '/api/delete', 'node1');

  const res = await report(env, 'node1', '9.9.9.9:9999');
  assert.match(await res.text(), /^Update Success/);
  const html = await (await panel(env, KEY)).text();
  assert.ok(!html.includes(CARD('node1')), '重新上报后依然不该出现');
});

test('删除不存在的节点也不算失败（幂等）', async () => {
  const env = newEnv();
  const body = await (await post(env, '/api/delete', 'never-seen')).json();
  assert.equal(body.ok, true);
  assert.equal(body.hadAddress, false);
});

test('恢复：删掉墓碑，卡片带着地址回来', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  await post(env, '/api/delete', 'node1');

  const res = await post(env, '/api/restore', 'node1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.restoredAddress, '1.2.3.4:8080', '应用墓碑里的地址还原');
  assert.equal(await env.LUCKY_STORE.get('HIDDEN_node1'), null);

  const html = await (await panel(env)).text();
  assert.ok(html.includes(CARD('node1')));
  assert.ok(html.includes('1.2.3.4:8080'));
});

test('恢复时若节点已重新上报，用新地址、不覆盖', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  await post(env, '/api/delete', 'node1');
  await report(env, 'node1', '9.9.9.9:9999');

  const body = await (await post(env, '/api/restore', 'node1')).json();
  assert.equal(body.restoredAddress, null, '已有新数据时不走墓碑还原');
  assert.equal(await env.LUCKY_STORE.get('SERVICE_node1'), '9.9.9.9:9999');
  assert.ok((await (await panel(env)).text()).includes('9.9.9.9:9999'));
});

test('恢复接口同样需要 key', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  await post(env, '/api/delete', 'node1');
  assert.equal((await post(env, '/api/restore', 'node1', 'bad')).status, 403);
  assert.ok(await env.LUCKY_STORE.get('HIDDEN_node1'), '未授权不能清墓碑');
});

/* ---------- 功能 2：自动折叠（前端逻辑，断言脚本里的实现在） ---------- */

test('自动折叠逻辑：阈值 3 次、写 localStorage、可开关、恢复后自动展开', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  await report(env, 'node2', '5.6.7.8:80');
  const html = await (await panel(env)).text();

  assert.ok(html.includes('const COLLAPSE_AFTER = 3;'), '阈值注入为 3');
  assert.ok(html.includes('markFail(name)'), '超时要计数');
  assert.ok(html.includes("card.classList.toggle('collapsed'"), '折叠靠 collapsed 类');
  assert.ok(html.includes('stun_panel_state_v1'), '状态要持久化');
  assert.ok(html.includes('autoCollapseToggle'), '要有开关');
  assert.ok(html.includes('expandAllBtn'), '要有全部展开');
  assert.match(html, /s\.fails >= COLLAPSE_AFTER/);
  assert.match(html, /const wasCollapsed = s\.collapsed;[\s\S]{0,80}s\.collapsed = false;/);
  assert.ok(html.includes('.card-wrap.collapsed'));
});

test('页面脚本里不能出现未替换的模板插值（否则会把 Worker 模板字符串搞坏）', async () => {
  const env = newEnv();
  await report(env, 'node1', '1.2.3.4:8080');
  const html = await (await panel(env, KEY)).text();
  const clientScript = html.split('<script>')[1].split('</script>')[0];
  assert.ok(!clientScript.includes('`'), '客户端脚本里不能有反引号');
  assert.ok(!clientScript.includes('${'), '客户端脚本里不能有未替换的 ${');
});

/**
 * STUN-Panel — Lucky STUN 内网穿透动态端口导航面板（Cloudflare Worker 单文件版）
 *
 * 数据流：
 *   Lucky --(webhook: /?key=K&name=N&addr=IP:PORT)--> KV: SERVICE_<N> = "IP:PORT"
 *   浏览器 --(GET /)--> 渲染卡片，前端每 5s fetch 一次节点地址测延迟
 *   浏览器 --(GET /<N>)--> 302 跳转到该节点实时地址
 *
 * 面板功能：
 *   1. 手动删除节点卡片（管理员：URL 带 ?key=，删除后写 HIDDEN_ 墓碑，Lucky 再上报也不会复活）
 *   2. 连续超时的节点卡片自动折叠（前端 localStorage 记录连续超时次数，恢复后自动展开）
 */

const DEFAULT_AUTH_KEY = "123456";
const COLLAPSE_THRESHOLD = 3;
const MAX_NAME_LEN = 64;

/* ---------------- 工具函数 ---------------- */

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_NAME_LEN) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null; // 控制字符一律拒绝
  return name;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json;charset=UTF-8", "Cache-Control": "no-store" }
  });
}

function formatAge(now, lastUpdate) {
  const diffMin = Math.floor((now - lastUpdate) / 60000);
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour > 0) return diffHour + "小时" + (diffMin % 60) + "分钟前更新";
  if (diffMin > 0) return diffMin + "分钟前更新";
  return "刚刚更新";
}

/* ---------------- Worker 入口 ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requiredKey = env.AUTH_KEY || DEFAULT_AUTH_KEY;
    const isAdmin = url.searchParams.get("key") === requiredKey;

    /* --- 1. Lucky Webhook 上报：/?key=K&name=N&addr=IP:PORT --- */
    if (url.searchParams.has("name") && url.searchParams.has("addr")) {
      if (!isAdmin) return new Response("Unauthorized", { status: 403 });

      const name = cleanName(url.searchParams.get("name"));
      const addr = (url.searchParams.get("addr") || "").trim();
      if (!name || !addr) return new Response("Bad Request: invalid name or addr", { status: 400 });

      // 注意：地址照常写入（即使是已删除的节点），这样"恢复"时立刻就有最新地址；
      // 面板渲染时按 HIDDEN_ 墓碑跳过，所以已删除的节点不会复活。
      await env.LUCKY_STORE.put("SERVICE_" + name, addr, {
        metadata: { lastUpdate: Date.now() }
      });

      // 这个字符串是 Lucky 判断调用成功的依据，不要改。
      return new Response("Update Success: " + name + " -> " + addr);
    }

    /* --- 2. 管理员接口：删除 / 恢复节点 --- */
    if (url.pathname === "/api/delete" || url.pathname === "/api/restore") {
      if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405);
      if (!isAdmin) return jsonResponse({ ok: false, error: "Unauthorized" }, 403);

      const name = cleanName(url.searchParams.get("name"));
      if (!name) return jsonResponse({ ok: false, error: "invalid name" }, 400);

      const serviceKey = "SERVICE_" + name;
      const hiddenKey = "HIDDEN_" + name;

      if (url.pathname === "/api/delete") {
        // 先读旧值：墓碑里留一份地址，恢复时可以直接还原
        const existing = await env.LUCKY_STORE.getWithMetadata(serviceKey);
        await env.LUCKY_STORE.put(hiddenKey, existing.value || "", {
          metadata: {
            at: Date.now(),
            addr: existing.value || null,
            lastUpdate: (existing.metadata && existing.metadata.lastUpdate) || null
          }
        });
        await env.LUCKY_STORE.delete(serviceKey);
        return jsonResponse({ ok: true, name: name, hadAddress: Boolean(existing.value) });
      }

      // restore
      const hidden = await env.LUCKY_STORE.getWithMetadata(hiddenKey);
      await env.LUCKY_STORE.delete(hiddenKey);
      let restoredAddress = null;
      if (!(await env.LUCKY_STORE.get(serviceKey)) && hidden.value) {
        // 节点停止上报时靠墓碑里的地址还原，不必等 Lucky 下一次上报
        await env.LUCKY_STORE.put(serviceKey, hidden.value, {
          metadata: { lastUpdate: (hidden.metadata && hidden.metadata.lastUpdate) || Date.now() }
        });
        restoredAddress = hidden.value;
      }
      return jsonResponse({ ok: true, name: name, restoredAddress: restoredAddress });
    }

    /* --- 3. 快捷跳转 /<节点名> --- */
    const path = url.pathname.replace(/^\/+/, "");
    if (path && !path.startsWith("api/")) {
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch (e) {
        decoded = path;
      }
      const targetAddr = await env.LUCKY_STORE.get("SERVICE_" + decoded);
      if (targetAddr) {
        const redirectUrl = targetAddr.startsWith("http") ? targetAddr : "http://" + targetAddr;
        return Response.redirect(redirectUrl, 302);
      }
    }

    /* --- 4. 生成导航页 --- */
    const [serviceList, hiddenList] = await Promise.all([
      env.LUCKY_STORE.list({ prefix: "SERVICE_" }),
      env.LUCKY_STORE.list({ prefix: "HIDDEN_" })
    ]);
    const hiddenNames = hiddenList.keys.map(function (k) { return k.name.slice("HIDDEN_".length); });
    const hiddenSet = new Set(hiddenNames);

    const now = Date.now();
    const sorted = serviceList.keys
      .map(function (k) { return { key: k.name, name: k.name.slice("SERVICE_".length) }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, "zh-Hans-CN"); });

    let servicesHtml = "";
    for (const item of sorted) {
      const name = item.name;
      if (hiddenSet.has(name)) continue; // 已删除的节点不渲染

      const { value: addr, metadata } = await env.LUCKY_STORE.getWithMetadata(item.key);
      if (!addr) continue;

      const timeText = formatAge(now, (metadata && metadata.lastUpdate) || now);
      const safeName = escapeHtml(name);

      servicesHtml += `
        <div class="card-wrap service-card" data-name="${safeName}" data-addr="${escapeHtml(addr)}">
          <a class="card-link" href="/${encodeURIComponent(name)}" aria-label="${safeName}"></a>
          <div class="service-info">
            <span class="service-name">${escapeHtml(name.toUpperCase())}</span>
            <span class="service-addr">${escapeHtml(addr)}</span>
            <span class="uptime-tag">更新时间: ${escapeHtml(timeText)}</span>
            <span class="collapse-hint"></span>
          </div>
          <div class="card-side">
            <span class="ping-tag">检测中</span>
            <div class="card-actions">
              <button type="button" class="icon-btn collapse-btn" title="折叠 / 展开">⌄</button>
              ${isAdmin ? '<button type="button" class="icon-btn del-btn" title="删除此节点">×</button>' : ""}
            </div>
          </div>
        </div>
      `;
    }

    let hiddenHtml = "";
    if (isAdmin) {
      for (const name of hiddenNames) {
        const { metadata } = await env.LUCKY_STORE.getWithMetadata("HIDDEN_" + name);
        const at = metadata && metadata.at ? new Date(metadata.at) : null;
        const atText = at ? at.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "未知时间";
        hiddenHtml += `
          <span class="hidden-item" data-name="${escapeHtml(name)}">
            <span class="hidden-name">${escapeHtml(name)}</span>
            <span class="hidden-time">${escapeHtml(atText)}</span>
            <button type="button" class="mini-btn restore-btn">恢复</button>
          </span>
        `;
      }
    }
    const adminAreaHtml = isAdmin
      ? `
        <div class="admin-area">
          <div class="admin-title">
            已删除节点：<span id="hiddenCount">${hiddenNames.length}</span> 个
            <span class="admin-note">（不显示在面板中，Lucky 再次上报也不会恢复）</span>
          </div>
          <div class="hidden-list" id="hiddenList">${hiddenHtml || '<span class="admin-empty">暂无</span>'}</div>
        </div>
      `
      : "";

    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN" data-theme="dark">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>STUN 监控导航</title>
        <style>
            :root[data-theme="dark"] {
                --bg-color: #121212;
                --text-main: #d4d4d4;
                --text-title: #ffffff;
                --card-bg: rgba(30, 30, 30, 0.8);
                --card-border: #333;
                --card-hover-bg: rgba(45, 45, 45, 0.95);
                --tag-bg: rgba(255, 255, 255, 0.05);
                --sub-text: #888;
                --shadow: 0 8px 32px rgba(0,0,0,0.5);
            }
            :root[data-theme="light"] {
                --bg-color: #f0f0f2;
                --text-main: #1d1d1f;
                --text-title: #000000;
                --card-bg: rgba(255, 255, 255, 0.7);
                --card-border: #ccd0d5;
                --card-hover-bg: rgba(255, 255, 255, 1);
                --tag-bg: rgba(0, 0, 0, 0.05);
                --sub-text: #424245;
                --shadow: 0 8px 32px rgba(0,0,0,0.06);
            }

            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                background-color: var(--bg-color); color: var(--text-main); 
                font-family: -apple-system, system-ui, sans-serif; 
                min-height: 100vh; display: flex; flex-direction: column; align-items: center; 
                transition: background-color 0.4s ease; overflow-x: hidden; overflow-y: auto;
            }

            canvas { mix-blend-mode: difference; pointer-events: none; }

            .theme-toggle {
                position: absolute; top: 20px; right: 20px; z-index: 100;
                padding: 10px 18px; border-radius: 30px; border: 1px solid var(--card-border);
                background: var(--card-bg); color: var(--text-main); cursor: pointer;
                font-size: 0.85rem; backdrop-filter: blur(10px); transition: all 0.3s;
            }

            .container { flex: 1; z-index: 10; width: 100%; max-width: 1150px; padding: 80px 24px; display: flex; flex-direction: column; align-items: center; }
            h1 { font-size: 2.2rem; font-weight: 300; margin-bottom: 2rem; color: var(--text-title); letter-spacing: 2px; }

            .panel-controls {
                display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
                margin-bottom: 2rem; font-size: 0.8rem; color: var(--sub-text);
            }
            .panel-controls label { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; }
            .panel-controls input[type="checkbox"] { width: 15px; height: 15px; accent-color: #007acc; cursor: pointer; }
            .status-line { font-size: 0.78rem; color: var(--sub-text); }
            .mini-btn {
                padding: 6px 12px; border-radius: 8px; border: 1px solid var(--card-border);
                background: var(--card-bg); color: var(--text-main); cursor: pointer;
                font-size: 0.78rem; transition: all 0.25s;
            }
            .mini-btn:hover { border-color: #007acc; color: var(--text-title); }

            .grid-area { width: 100%; }
            .grid { 
                display: grid; 
                gap: 24px; 
                width: 100%;
                justify-content: center;
                grid-template-columns: repeat(auto-fit, minmax(300px, 340px));
            }

            .card-wrap {
                position: relative; display: flex; align-items: stretch;
                border: 1px solid var(--card-border); background: var(--card-bg);
                border-radius: 12px; transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
                backdrop-filter: blur(15px); box-shadow: var(--shadow);
                min-height: 120px; overflow: hidden;
            }
            .card-wrap:hover { border-color: #007acc; background: var(--card-hover-bg); transform: translateY(-5px); }
            .card-link { position: absolute; inset: 0; z-index: 1; }

            .service-info { flex: 1; min-width: 0; text-align: left; display: flex; flex-direction: column; padding: 24px; }
            .service-name { font-size: 1.25rem; font-weight: 700; margin-bottom: 6px; color: var(--text-title); }
            .service-addr { font-size: 0.8rem; color: var(--sub-text); font-family: monospace; margin-bottom: 10px; opacity: 0.8; word-break: break-all; }
            .uptime-tag { font-size: 0.75rem; color: var(--sub-text); }
            .collapse-hint { display: none; font-size: 0.72rem; color: var(--sub-text); }

            .card-side {
                position: relative; z-index: 2; display: flex; flex-direction: column;
                align-items: flex-end; justify-content: space-between; gap: 10px; padding: 20px 16px;
            }
            .card-actions { display: flex; gap: 8px; opacity: 0; transition: opacity 0.2s; }
            .card-wrap:hover .card-actions, .card-wrap.collapsed .card-actions { opacity: 1; }
            .icon-btn {
                width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--card-border);
                background: var(--tag-bg); color: var(--sub-text); cursor: pointer;
                font-size: 0.9rem; line-height: 1; display: flex; align-items: center; justify-content: center;
                transition: all 0.2s;
            }
            .icon-btn:hover { color: var(--text-title); border-color: #007acc; background: var(--card-hover-bg); }
            .del-btn:hover { color: #ef5350; border-color: #ef5350; }

            /* 折叠态：只留一行，名字 + 状态 */
            .card-wrap.collapsed { min-height: 0; opacity: 0.85; }
            .card-wrap.collapsed .service-info { padding: 14px 18px; flex-direction: row; align-items: center; gap: 10px; }
            .card-wrap.collapsed .service-name { margin: 0; font-size: 1rem; }
            .card-wrap.collapsed .service-addr, .card-wrap.collapsed .uptime-tag { display: none; }
            .card-wrap.collapsed .collapse-hint { display: inline; flex: 1; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .card-wrap.collapsed .card-side { padding: 12px 14px; flex-direction: row; align-items: center; }
            .card-wrap.collapsed .card-actions { flex-direction: row; }

            .ping-tag { font-size: 0.85rem; font-weight: 600; font-family: monospace; padding: 4px 12px; border-radius: 6px; background: var(--tag-bg); white-space: nowrap; }
            .ping-low { color: #2e7d32; }
            .ping-mid { color: #0277bd; }
            .ping-high { color: #c62828; }
            
            [data-theme="dark"] .ping-low { color: #81c784; }
            [data-theme="dark"] .ping-mid { color: #4fc3f7; }
            [data-theme="dark"] .ping-high { color: #ef5350; }

            .admin-area {
                width: 100%; margin-top: 48px; padding: 20px; border-radius: 12px;
                border: 1px dashed var(--card-border); background: var(--card-bg);
                font-size: 0.8rem; color: var(--sub-text);
            }
            .admin-title { margin-bottom: 12px; color: var(--text-main); }
            .admin-note { font-size: 0.72rem; opacity: 0.8; }
            .admin-empty { opacity: 0.7; }
            .hidden-list { display: flex; flex-wrap: wrap; gap: 10px; }
            .hidden-item {
                display: flex; align-items: center; gap: 10px; padding: 6px 10px;
                border: 1px solid var(--card-border); border-radius: 8px; background: var(--tag-bg);
            }
            .hidden-name { color: var(--text-title); font-family: monospace; }
            .hidden-time { font-size: 0.72rem; opacity: 0.7; }

            .toast {
                position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%) translateY(20px);
                background: var(--card-hover-bg); color: var(--text-title); border: 1px solid var(--card-border);
                padding: 12px 20px; border-radius: 10px; font-size: 0.85rem; z-index: 200;
                opacity: 0; pointer-events: none; transition: all 0.3s; backdrop-filter: blur(10px);
                box-shadow: var(--shadow); max-width: 90vw;
            }
            .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

            footer { 
                width: 100%; padding: 60px 20px; text-align: center; 
                font-size: 0.9rem; color: var(--sub-text); z-index: 10;
            }
            footer a { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--sub-text); }

            @media (hover: none) {
                .card-actions { opacity: 1; }
            }
        </style>
    </head>
    <body>
        <button class="theme-toggle" onclick="toggleTheme()" id="themeBtn">切换到浅色模式</button>

        <div class="container">
            <h1>节点实时状态</h1>

            <div class="panel-controls">
                <label><input type="checkbox" id="autoCollapseToggle" checked> 自动折叠超时节点（连续 ${COLLAPSE_THRESHOLD} 次超时）</label>
                <button type="button" class="mini-btn" id="expandAllBtn">全部展开</button>
                <span class="status-line" id="statusLine"></span>
            </div>

            <div class="grid-area">
                <div class="grid">
                    ${servicesHtml || '<div style="color:var(--sub-text); grid-column: 1/-1;">等待 Lucky 数据上报...</div>'}
                </div>
            </div>

            ${adminAreaHtml}
        </div>

        <footer>
            <a href="https://github.com/i5114514kf/STUN-Panel" target="_blank">View on GitHub</a>
        </footer>

        <div class="toast" id="toast"></div>

        <script>
            // 管理员模式下才有 KEY，普通访问为 null，删除按钮根本不渲染
            const KEY = ${isAdmin ? JSON.stringify(requiredKey) : "null"};
            const COLLAPSE_AFTER = ${COLLAPSE_THRESHOLD};
            const STATE_KEY = 'stun_panel_state_v1';
            const PREF_KEY = 'stun_panel_prefs_v1';

            let nodeState = {};                                  // name -> { fails, collapsed }
            let prefs = { autoCollapse: true };

            function loadLocal() {
                try {
                    const rawState = localStorage.getItem(STATE_KEY);
                    if (rawState) nodeState = JSON.parse(rawState) || {};
                    const rawPrefs = localStorage.getItem(PREF_KEY);
                    if (rawPrefs) prefs = Object.assign(prefs, JSON.parse(rawPrefs) || {});
                } catch (e) { /* 隐私模式下 localStorage 不可用，退化成内存状态 */ }
            }
            function saveLocal() {
                try {
                    localStorage.setItem(STATE_KEY, JSON.stringify(nodeState));
                    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
                } catch (e) { /* 忽略 */ }
            }
            function stateOf(name) {
                if (!nodeState[name]) nodeState[name] = { fails: 0, collapsed: false };
                return nodeState[name];
            }

            function cards() { return document.querySelectorAll('.card-wrap.service-card'); }

            function cardOf(name) {
                let found = null;
                cards().forEach(function (el) { if (el.dataset.name === name) found = el; });
                return found;
            }

            function renderCard(name, flash) {
                const card = cardOf(name);
                if (!card) return;
                const s = stateOf(name);
                card.classList.toggle('collapsed', !!s.collapsed);
                const hint = card.querySelector('.collapse-hint');
                if (hint) hint.innerText = s.collapsed ? ('已折叠 · 超时 ' + s.fails + ' 次') : '';
                const btn = card.querySelector('.collapse-btn');
                if (btn) btn.innerText = s.collapsed ? '⌃' : '⌄';
                if (flash) {
                    card.style.borderColor = '#2e7d32';
                    setTimeout(function () { card.style.borderColor = ''; }, 1500);
                }
                refreshStatus();
            }

            function refreshStatus() {
                const line = document.getElementById('statusLine');
                if (!line) return;
                let total = 0, folded = 0;
                cards().forEach(function (el) {
                    total++;
                    if (el.classList.contains('collapsed')) folded++;
                });
                line.innerText = folded ? ('共 ' + total + ' 个节点，已折叠 ' + folded + ' 个') : ('共 ' + total + ' 个节点');
            }

            function markSuccess(name) {
                const s = stateOf(name);
                if (s.fails === 0 && !s.collapsed) return;
                s.fails = 0;
                const wasCollapsed = s.collapsed;
                s.collapsed = false;
                saveLocal();
                renderCard(name, wasCollapsed);
            }

            function markFail(name) {
                const s = stateOf(name);
                s.fails++;
                if (prefs.autoCollapse && !s.collapsed && s.fails >= COLLAPSE_AFTER) {
                    s.collapsed = true;
                }
                saveLocal();
                renderCard(name);
            }

            function toggleCollapse(name) {
                const s = stateOf(name);
                s.collapsed = !s.collapsed;
                if (!s.collapsed) s.fails = 0;   // 手动展开 = 清零计数，再连续超时 3 次会重新折叠
                saveLocal();
                renderCard(name);
            }

            function toggleTheme() {
                const root = document.documentElement;
                const btn = document.getElementById('themeBtn');
                const isDark = root.getAttribute('data-theme') === 'dark';
                root.setAttribute('data-theme', isDark ? 'light' : 'dark');
                btn.innerText = isDark ? '切换到深色模式' : '切换到浅色模式';
            }

            function toast(message) {
                const box = document.getElementById('toast');
                if (!box) return;
                box.innerText = message;
                box.classList.add('show');
                clearTimeout(toast.timer);
                toast.timer = setTimeout(function () { box.classList.remove('show'); }, 3000);
            }

            async function testLatency(card) {
                const tag = card.querySelector('.ping-tag');
                if (!tag) return;
                const name = card.dataset.name;
                const addr = card.dataset.addr;
                const start = Date.now();
                const testUrl = addr.indexOf('http') === 0 ? addr : 'http://' + addr;
                try {
                    const controller = new AbortController();
                    const timer = setTimeout(function () { controller.abort(); }, 3000);
                    await fetch(testUrl, { mode: 'no-cors', signal: controller.signal });
                    clearTimeout(timer);
                    displayPing(tag, Date.now() - start);
                    markSuccess(name);
                } catch (e) {
                    const latency = Date.now() - start;
                    if (latency < 2900) { displayPing(tag, latency); markSuccess(name); }
                    else { tag.innerText = '超时'; tag.className = 'ping-tag ping-high'; markFail(name); }
                }
            }

            function displayPing(tag, ms) {
                tag.innerText = ms + 'ms';
                if (ms <= 50) tag.className = 'ping-tag ping-low';
                else if (ms <= 200) tag.className = 'ping-tag ping-mid';
                else tag.className = 'ping-tag ping-high';
            }

            function updateAll() {
                cards().forEach(function (card) { testLatency(card); });
            }

            /* ---------- 管理员操作：删除 / 恢复 ---------- */

            async function deleteNode(name) {
                if (!KEY) return;
                const ok = confirm('确认删除节点「' + name + '」？删除后卡片不再显示，Lucky 再次上报也不会恢复；可在页面底部“已删除节点”里恢复。');
                if (!ok) return;
                try {
                    const res = await fetch('/api/delete?key=' + encodeURIComponent(KEY) + '&name=' + encodeURIComponent(name), { method: 'POST' });
                    const data = await res.json().catch(function () { return null; });
                    if (res.ok && data && data.ok) {
                        const card = cardOf(name);
                        if (card) {
                            card.style.opacity = '0';
                            card.style.transform = 'scale(0.92)';
                            setTimeout(function () { card.remove(); refreshStatus(); }, 250);
                        }
                        addHiddenItem(name);
                        toast('已删除节点 ' + name);
                    } else {
                        toast('删除失败：' + ((data && data.error) || res.status));
                    }
                } catch (e) {
                    toast('删除失败：网络错误');
                }
            }

            async function restoreNode(name) {
                if (!KEY) return;
                try {
                    const res = await fetch('/api/restore?key=' + encodeURIComponent(KEY) + '&name=' + encodeURIComponent(name), { method: 'POST' });
                    const data = await res.json().catch(function () { return null; });
                    if (res.ok && data && data.ok) {
                        toast('已恢复节点 ' + name + '，正在刷新…');
                        setTimeout(function () { location.reload(); }, 700);
                    } else {
                        toast('恢复失败：' + ((data && data.error) || res.status));
                    }
                } catch (e) {
                    toast('恢复失败：网络错误');
                }
            }

            function addHiddenItem(name) {
                const list = document.getElementById('hiddenList');
                if (!list) return;
                const empty = list.querySelector('.admin-empty');
                if (empty) empty.remove();
                const item = document.createElement('span');
                item.className = 'hidden-item';
                item.dataset.name = name;
                const nameEl = document.createElement('span');
                nameEl.className = 'hidden-name';
                nameEl.textContent = name;
                const timeEl = document.createElement('span');
                timeEl.className = 'hidden-time';
                timeEl.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'mini-btn restore-btn';
                btn.textContent = '恢复';
                item.appendChild(nameEl);
                item.appendChild(timeEl);
                item.appendChild(btn);
                list.appendChild(item);
                const counter = document.getElementById('hiddenCount');
                if (counter) counter.innerText = String(list.querySelectorAll('.hidden-item').length);
            }

            document.addEventListener('click', function (event) {
                const delBtn = event.target.closest ? event.target.closest('.del-btn') : null;
                if (delBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    const card = delBtn.closest('.card-wrap');
                    if (card) deleteNode(card.dataset.name);
                    return;
                }
                const colBtn = event.target.closest ? event.target.closest('.collapse-btn') : null;
                if (colBtn) {
                    event.preventDefault();
                    event.stopPropagation();
                    const card = colBtn.closest('.card-wrap');
                    if (card) toggleCollapse(card.dataset.name);
                    return;
                }
                const restoreBtn = event.target.closest ? event.target.closest('.restore-btn') : null;
                if (restoreBtn) {
                    const item = restoreBtn.closest('.hidden-item');
                    if (item) restoreNode(item.dataset.name);
                }
            });

            /* ---------- 启动 ---------- */
            loadLocal();
            const toggle = document.getElementById('autoCollapseToggle');
            if (toggle) {
                toggle.checked = !!prefs.autoCollapse;
                toggle.addEventListener('change', function () {
                    prefs.autoCollapse = toggle.checked;
                    saveLocal();
                    if (!prefs.autoCollapse) {
                        Object.keys(nodeState).forEach(function (n) {
                            if (nodeState[n].collapsed) { nodeState[n].collapsed = false; renderCard(n); }
                        });
                    }
                });
            }
            const expandAllBtn = document.getElementById('expandAllBtn');
            if (expandAllBtn) {
                expandAllBtn.addEventListener('click', function () {
                    Object.keys(nodeState).forEach(function (n) {
                        if (nodeState[n].collapsed) { nodeState[n].collapsed = false; nodeState[n].fails = 0; }
                    });
                    saveLocal();
                    cards().forEach(function (card) { renderCard(card.dataset.name); });
                });
            }
            cards().forEach(function (card) { renderCard(card.dataset.name); });
            refreshStatus();

            updateAll();
            setInterval(updateAll, 5000);
        </script>

        <script color="255,255,255" opacity="0.6" zIndex="-1" count="100">
            !function(){function n(n,e,t){return n.getAttribute(e)||t}function e(n){return document.getElementsByTagName(n)}function t(){var t=e("script"),o=t.length,i=t[o-1];return{l:o,z:n(i,"zIndex",-1),o:n(i,"opacity",.5),c:n(i,"color","0,0,0"),n:n(i,"count",99)}}function o(){a=m.width=window.innerWidth||document.documentElement.clientWidth||document.body.clientWidth,c=m.height=window.innerHeight||document.documentElement.clientHeight||document.body.clientHeight}function i(){r.clearRect(0,0,a,c);var n,e,t,o,m,l;s.forEach(function(i,x){for(i.x+=i.xa,i.y+=i.ya,i.xa*=i.x>a||i.x<0?-1:1,i.ya*=i.y>c||i.y<0?-1:1,r.fillRect(i.x-.5,i.y-.5,1,1),e=x+1;e<u.length;e++)n=u[e],null!==n.x&&null!==n.y&&(o=i.x-n.x,m=i.y-n.y,l=o*o+m*m,l<n.max&&(n===y&&l>=n.max/2&&(i.x-=.03*o,i.y-=.03*m),t=(n.max-l)/n.max,r.beginPath(),r.lineWidth=t/2,r.strokeStyle="rgba("+d.c+","+(t+.2)+")",r.moveTo(i.x,i.y),r.lineTo(n.x,n.y),r.stroke()))}),x(i)}var a,c,u,m=document.createElement("canvas"),d=t(),l="c_n"+d.l,r=m.getContext("2d"),x=window.requestAnimationFrame||window.webkitRequestAnimationFrame||window.mozRequestAnimationFrame||window.oRequestAnimationFrame||window.msRequestAnimationFrame||function(n){window.setTimeout(n,1e3/45)},w=Math.random,y={x:null,y:null,max:2e4};m.id=l,m.style.cssText="position:fixed;top:0;left:0;z-index:" + d.z + ";opacity:" + d.o,e("body")[0].appendChild(m),o(),window.onresize=o,window.onmousemove=function(n){n=n||window.event,y.x=n.clientX,y.y=n.clientY},window.onmouseout=function(){y.x=null,y.y=null};for(var s=[],f=0;d.n>f;f++){var h=w()*a,g=w()*c,v=2*w()-1,p=2*w()-1;s.push({x:h,y:g,xa:v,ya:p,max:6e3})}u=s.concat([y]),setTimeout(function(){i()},100)}();
        </script>
    </body>
    </html>
    `;

    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" }
    });
  }
};

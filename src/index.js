export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authKey = url.searchParams.get("key");

    // --- 1. 处理 Lucky Webhook 更新 ---
    if (url.searchParams.has("name") && url.searchParams.has("addr")) {
      if (authKey !== "123456") return new Response("Unauthorized", { status: 403 });
      const name = url.searchParams.get("name");
      const addr = url.searchParams.get("addr");
      await env.LUCKY_STORE.put(`SERVICE_${name}`, addr, {
        metadata: { lastUpdate: Date.now() }
      });
      return new Response(`Update Success: ${name} -> ${addr}`);
    }

    // --- 2. 特定路径跳转 ---
    const path = url.pathname.replace("/", "");
    if (path && path !== "") {
      const targetAddr = await env.LUCKY_STORE.get(`SERVICE_${path}`);
      if (targetAddr) {
        const redirectUrl = targetAddr.startsWith('http') ? targetAddr : `http://${targetAddr}`;
        return Response.redirect(redirectUrl, 302);
      }
    }

    // --- 3. 生成导航页 ---
    const keys = await env.LUCKY_STORE.list({ prefix: "SERVICE_" });
    let servicesHtml = "";
    const now = Date.now();

    for (const key of keys.keys) {
      const name = key.name.replace("SERVICE_", "");
      const { value: addr, metadata } = await env.LUCKY_STORE.getWithMetadata(key.name);
      if (!addr) continue;

      const lastUpdate = metadata?.lastUpdate || now;
      const diffMs = now - lastUpdate;
      const diffMin = Math.floor(diffMs / 60000);
      const diffHour = Math.floor(diffMin / 60);
      
      let timeText = "";
      if (diffHour > 0) timeText = `${diffHour}小时${diffMin % 60}分钟前更新`;
      else if (diffMin > 0) timeText = `${diffMin}分钟前更新`;
      else timeText = "刚刚更新";

      servicesHtml += `
        <div class="nav-btn-wrapper">
          <a href="/${name}" class="nav-btn service-card" data-name="${name}" data-addr="${addr}">
            <div class="service-info">
                <span class="service-name">${name.toUpperCase()}</span>
                <span class="service-addr">${addr}</span>
                <span class="uptime-tag">更新时间: ${timeText}</span>
            </div>
            <span class="ping-tag" id="ping-${name}">检测中</span>
          </a>
        </div>
      `;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN" data-theme="dark">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CPer's STUN 监控导航</title>
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
            h1 { font-size: 2.2rem; font-weight: 300; margin-bottom: 3.5rem; color: var(--text-title); letter-spacing: 2px; }
            
            .grid-area { width: 100%; }
            .grid { 
                display: grid; 
                gap: 24px; 
                width: 100%;
                justify-content: center;
                grid-template-columns: repeat(auto-fit, minmax(300px, 340px));
            }

            .nav-btn {
                display: flex; justify-content: space-between; align-items: center;
                padding: 24px; color: inherit; text-decoration: none;
                border: 1px solid var(--card-border); background: var(--card-bg);
                border-radius: 12px; transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
                backdrop-filter: blur(15px); box-shadow: var(--shadow);
                min-height: 120px;
            }
            .nav-btn:hover { border-color: #007acc; background: var(--card-hover-bg); transform: translateY(-5px); }
            
            .service-info { text-align: left; display: flex; flex-direction: column; }
            .service-name { font-size: 1.25rem; font-weight: 700; margin-bottom: 6px; color: var(--text-title); }
            .service-addr { font-size: 0.8rem; color: var(--sub-text); font-family: monospace; margin-bottom: 10px; opacity: 0.8; }
            .uptime-tag { font-size: 0.75rem; color: var(--sub-text); }
            
            .ping-tag { font-size: 0.85rem; font-weight: 600; font-family: monospace; padding: 4px 12px; border-radius: 6px; background: var(--tag-bg); }
            .ping-low { color: #2e7d32; }
            .ping-mid { color: #0277bd; }
            .ping-high { color: #c62828; }
            
            [data-theme="dark"] .ping-low { color: #81c784; }
            [data-theme="dark"] .ping-mid { color: #4fc3f7; }
            [data-theme="dark"] .ping-high { color: #ef5350; }

            footer { 
                width: 100%; padding: 60px 20px; text-align: center; 
                font-size: 0.9rem; color: var(--sub-text); z-index: 10;
            }
            footer a { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--sub-text); }
        </style>
    </head>
    <body>
        <button class="theme-toggle" onclick="toggleTheme()" id="themeBtn">切换到浅色模式</button>

        <div class="container">
            <h1>节点实时状态</h1>
            <div class="grid-area">
                <div class="grid">
                    ${servicesHtml || '<div style="color:var(--sub-text); grid-column: 1/-1;">等待 Lucky 数据上报...</div>'}
                </div>
            </div>
        </div>

        <footer>
            <a href="https://github.com/i5114514kf/STUN-Panel" target="_blank">View on GitHub</a>
        </footer>

        <script>
            function toggleTheme() {
                const root = document.documentElement;
                const btn = document.getElementById('themeBtn');
                const isDark = root.getAttribute('data-theme') === 'dark';
                root.setAttribute('data-theme', isDark ? 'light' : 'dark');
                btn.innerText = isDark ? '切换到深色模式' : '切换到浅色模式';
            }

            async function testLatency(name, addr) {
                const tag = document.getElementById('ping-' + name);
                const start = Date.now();
                const testUrl = addr.startsWith('http') ? addr : 'http://' + addr;
                try {
                    const controller = new AbortController();
                    setTimeout(() => controller.abort(), 3000);
                    await fetch(testUrl, { mode: 'no-cors', signal: controller.signal });
                    displayPing(tag, Date.now() - start);
                } catch (e) {
                    const latency = Date.now() - start;
                    if (latency < 2900) displayPing(tag, latency);
                    else { tag.innerText = '超时'; tag.className = 'ping-tag ping-high'; }
                }
            }

            function displayPing(tag, ms) {
                tag.innerText = ms + 'ms';
                if (ms <= 50) tag.className = 'ping-tag ping-low';
                else if (ms <= 200) tag.className = 'ping-tag ping-mid';
                else tag.className = 'ping-tag ping-high';
            }

            function updateAll() {
                document.querySelectorAll('.service-card').forEach(card => {
                    testLatency(card.dataset.name, card.dataset.addr);
                });
            }
            updateAll();
            setInterval(updateAll, 5000);
        </script>

        <script color="255,255,255" opacity="0.6" zIndex="-1" count="100">
            !function(){function n(n,e,t){return n.getAttribute(e)||t}function e(n){return document.getElementsByTagName(n)}function t(){var t=e("script"),o=t.length,i=t[o-1];return{l:o,z:n(i,"zIndex",-1),o:n(i,"opacity",.5),c:n(i,"color","0,0,0"),n:n(i,"count",99)}}function o(){a=m.width=window.innerWidth||document.documentElement.clientWidth||document.body.clientWidth,c=m.height=window.innerHeight||document.documentElement.clientHeight||document.body.clientHeight}function i(){r.clearRect(0,0,a,c);var n,e,t,o,m,l;s.forEach(function(i,x){for(i.x+=i.xa,i.y+=i.ya,i.xa*=i.x>a||i.x<0?-1:1,i.ya*=i.y>c||i.y<0?-1:1,r.fillRect(i.x-.5,i.y-.5,1,1),e=x+1;e<u.length;e++)n=u[e],null!==n.x&&null!==n.y&&(o=i.x-n.x,m=i.y-n.y,l=o*o+m*m,l<n.max&&(n===y&&l>=n.max/2&&(i.x-=.03*o,i.y-=.03*m),t=(n.max-l)/n.max,r.beginPath(),r.lineWidth=t/2,r.strokeStyle="rgba("+d.c+","+(t+.2)+")",r.moveTo(i.x,i.y),r.lineTo(n.x,n.y),r.stroke()))}),x(i)}var a,c,u,m=document.createElement("canvas"),d=t(),l="c_n"+d.l,r=m.getContext("2d"),x=window.requestAnimationFrame||window.webkitRequestAnimationFrame||window.mozRequestAnimationFrame||window.oRequestAnimationFrame||window.msRequestAnimationFrame||function(n){window.setTimeout(n,1e3/45)},w=Math.random,y={x:null,y:null,max:2e4};m.id=l,m.style.cssText="position:fixed;top:0;left:0;z-index:" + d.z + ";opacity:" + d.o,e("body")[0].appendChild(m),o(),window.onresize=o,window.onmousemove=function(n){n=n||window.event,y.x=n.clientX,y.y=n.clientY},window.onmouseout=function(){y.x=null,y.y=null};for(var s=[],f=0;d.n>f;f++){var h=w()*a,g=w()*c,v=2*w()-1,p=2*w()-1;s.push({x:h,y:g,xa:v,ya:p,max:6e3})}u=s.concat([y]),setTimeout(function(){i()},100)}();
        </script>
    </body>
    </html>
    `;

    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
};
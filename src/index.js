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
            <span class="ping-tag" id="ping-${name}">测速中</span>
          </a>
        </div>
      `;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CPer's STUN 实时监控导航</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                background-color: #1e1e1e; color: #d4d4d4; 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; 
                min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; 
                overflow-x: hidden; padding-top: 5vh;
            }
            .container { z-index: 10; width: 100%; max-width: 1000px; padding: 20px; text-align: center; }
            h1 { font-size: 2rem; font-weight: 300; margin-bottom: 3rem; color: #fff; letter-spacing: 3px; }
            
            /* 网格排版优化 */
            .grid { 
                display: grid; 
                gap: 20px; 
                grid-template-columns: 1fr; /* 默认移动端单列 */
            }

            /* PC端排版：当宽度大于 768px 时变为双列，大于 1000px 时变为三列 */
            @media (min-width: 768px) {
                .grid { grid-template-columns: repeat(2, 1fr); }
            }
            @media (min-width: 1024px) {
                .grid { grid-template-columns: repeat(3, 1fr); }
            }

            .nav-btn {
                display: flex; justify-content: space-between; align-items: center;
                padding: 20px; color: #fff; text-decoration: none;
                border: 1px solid #333; background: rgba(37, 37, 38, 0.7);
                border-radius: 8px; transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
                backdrop-filter: blur(10px); height: 100%;
            }
            
            .nav-btn:hover { 
                border-color: #007acc; 
                background: rgba(45, 45, 45, 0.9);
                transform: translateY(-5px); 
                box-shadow: 0 10px 20px rgba(0, 0, 0, 0.5); 
            }
            
            .service-info { text-align: left; display: flex; flex-direction: column; overflow: hidden; }
            .service-name { font-size: 1.2rem; font-weight: 500; margin-bottom: 6px; color: #eee; }
            .service-addr { 
                font-size: 0.75rem; color: #666; font-family: "Cascadia Code", Consolas, monospace; 
                margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; 
            }
            .uptime-tag { font-size: 0.7rem; color: #444; }
            
            .ping-tag { font-size: 0.8rem; font-family: monospace; padding: 4px 10px; border-radius: 4px; background: rgba(0,0,0,0.4); }
            .ping-low { color: #4caf50; border: 1px solid rgba(76, 175, 80, 0.2); }
            .ping-mid { color: #4fc3f7; border: 1px solid rgba(79, 195, 247, 0.2); }
            .ping-warn { color: #ffb74d; border: 1px solid rgba(255, 183, 77, 0.2); }
            .ping-high { color: #ef5350; border: 1px solid rgba(239, 83, 80, 0.2); }

            footer { padding: 40px 0; font-size: 0.8rem; color: #444; z-index: 10; }
            footer a { color: #555; text-decoration: none; }
            footer a:hover { color: #007acc; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>节点实时状态</h1>
            <div class="grid">
                ${servicesHtml || '<div style="color:#555; grid-column: 1/-1;">无在线节点</div>'}
            </div>
        </div>
        <footer><a href="https://beian.miit.gov.cn/" target="_blank">蜀ICP备2025160729号-2</a></footer>

        <script>
            async function testLatency(name, addr) {
                const tag = document.getElementById('ping-' + name);
                const start = Date.now();
                const testUrl = addr.startsWith('http') ? addr : 'http://' + addr;
                try {
                    const controller = new AbortController();
                    setTimeout(() => controller.abort(), 4000);
                    await fetch(testUrl, { mode: 'no-cors', signal: controller.signal });
                    displayPing(tag, Date.now() - start);
                } catch (e) {
                    const latency = Date.now() - start;
                    if (latency < 3800) displayPing(tag, latency);
                    else { tag.innerText = 'TIMEOUT'; tag.className = 'ping-tag ping-high'; }
                }
            }

            function displayPing(tag, ms) {
                tag.innerText = ms + 'ms';
                if (ms <= 50) tag.className = 'ping-tag ping-low';
                else if (ms <= 200) tag.className = 'ping-tag ping-mid';
                else if (ms <= 500) tag.className = 'ping-tag ping-warn';
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

        <script color="255,255,255" opacity="0.3" zIndex="-1" count="100">
            !function(){function n(n,e,t){return n.getAttribute(e)||t}function e(n){return document.getElementsByTagName(n)}function t(){var t=e("script"),o=t.length,i=t[o-1];return{l:o,z:n(i,"zIndex",-1),o:n(i,"opacity",.5),c:n(i,"color","0,0,0"),n:n(i,"count",99)}}function o(){a=m.width=window.innerWidth||document.documentElement.clientWidth||document.body.clientWidth,c=m.height=window.innerHeight||document.documentElement.clientHeight||document.body.clientHeight}function i(){r.clearRect(0,0,a,c);var n,e,t,o,m,l;s.forEach(function(i,x){for(i.x+=i.xa,i.y+=i.ya,i.xa*=i.x>a||i.x<0?-1:1,i.ya*=i.y>c||i.y<0?-1:1,r.fillRect(i.x-.5,i.y-.5,1,1),e=x+1;e<u.length;e++)n=u[e],null!==n.x&&null!==n.y&&(o=i.x-n.x,m=i.y-n.y,l=o*o+m*m,l<n.max&&(n===y&&l>=n.max/2&&(i.x-=.03*o,i.y-=.03*m),t=(n.max-l)/n.max,r.beginPath(),r.lineWidth=t/2,r.strokeStyle="rgba("+d.c+","+(t+.2)+")",r.moveTo(i.x,i.y),r.lineTo(n.x,n.y),r.stroke()))}),x(i)}var a,c,u,m=document.createElement("canvas"),d=t(),l="c_n"+d.l,r=m.getContext("2d"),x=window.requestAnimationFrame||window.webkitRequestAnimationFrame||window.mozRequestAnimationFrame||window.oRequestAnimationFrame||window.msRequestAnimationFrame||function(n){window.setTimeout(n,1e3/45)},w=Math.random,y={x:null,y:null,max:2e4};m.id=l,m.style.cssText="position:fixed;top:0;left:0;z-index:"+d.z+";opacity:"+d.o,e("body")[0].appendChild(m),o(),window.onresize=o,window.onmousemove=function(n){n=n||window.event,y.x=n.clientX,y.y=n.clientY},window.onmouseout=function(){y.x=null,y.y=null};for(var s=[],f=0;d.n>f;f++){var h=w()*a,g=w()*c,v=2*w()-1,p=2*w()-1;s.push({x:h,y:g,xa:v,ya:p,max:6e3})}u=s.concat([y]),setTimeout(function(){i()},100)}();
        </script>
    </body>
    </html>
    `;

    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
};
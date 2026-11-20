// Crestmont native-onboarding TEST SITES (Owner, 2026-11-20, Phase 6 Test B). TEST DATA only: no forms, no accounts,
// no tracking, nothing stored. One script, deployed as several Workers on workers.dev with VARIANT set per Worker
// (.github/workflows/native-test-sites.yml). Each variant is a different real-world page technology; every public
// page permits ONLY Crestmont's portfolio to frame it (or, for "refuses", nobody), and /login always refuses framing.
const CRESTMONT = "https://crestmontwebsitedevelopment.com https://www.crestmontwebsitedevelopment.com";
const P = "This is TEST DATA content for Crestmont's native portfolio onboarding trials. It exists only to be loaded, scrolled and clicked by a verification browser.";
const shell = (title, head, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${title} — Crestmont test site</title>${head}<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#e8ecf1;background:#0b1220}main,.wrap{max-width:900px;margin:0 auto;padding:24px}a{color:#7cc4ff}nav a{margin-right:16px}</style></head><body>${body}</body></html>`;
const nav = `<nav class="wrap"><a href="/">Home</a><a href="/about">About</a><a href="/login">Sign in</a></nav>`;
const paras = (n) => Array.from({ length: n }, (_, i) => `<p>Section ${i + 1}. ${P}</p>`).join("");

const VARIANTS = {
  // Plain server-rendered marketing page.
  static: () => shell("Static", "", `${nav}<main><h1>Static test site</h1><p>A plain server-rendered page.</p>${paras(30)}</main>`),
  // An essential, continuously animated WebGL scene (the "Earth" case).
  webgl: () => shell("WebGL", "", `${nav}<main><h1>WebGL test site</h1><canvas id="g" width="640" height="400" style="width:100%;max-width:640px;display:block"></canvas>${paras(25)}</main>
<script>(function(){var c=document.getElementById("g"),g=c.getContext("webgl");if(!g)return;var v=g.createShader(g.VERTEX_SHADER);g.shaderSource(v,"attribute vec2 p;uniform float t;void main(){float a=t;mat2 r=mat2(cos(a),-sin(a),sin(a),cos(a));gl_Position=vec4(r*p,0.,1.);}");g.compileShader(v);var f=g.createShader(g.FRAGMENT_SHADER);g.shaderSource(f,"precision mediump float;uniform float t;void main(){gl_FragColor=vec4(.3+.3*sin(t),.6,.9,1.);}");g.compileShader(f);var pr=g.createProgram();g.attachShader(pr,v);g.attachShader(pr,f);g.linkProgram(pr);g.useProgram(pr);var b=g.createBuffer();g.bindBuffer(g.ARRAY_BUFFER,b);g.bufferData(g.ARRAY_BUFFER,new Float32Array([0,.8,-.7,-.5,.7,-.5]),g.STATIC_DRAW);var l=g.getAttribLocation(pr,"p");g.enableVertexAttribArray(l);g.vertexAttribPointer(l,2,g.FLOAT,false,0,0);var u=g.getUniformLocation(pr,"t");function d(ms){g.clearColor(.04,.07,.15,1);g.clear(g.COLOR_BUFFER_BIT);g.uniform1f(u,ms/1000);g.drawArrays(g.TRIANGLES,0,3);requestAnimationFrame(d);}requestAnimationFrame(d);})();</script>`),
  // Client-rendered single-page app: the server sends an empty shell; the content is rendered by JavaScript.
  csr: () => shell("Client-rendered", "", `<div id="app" class="wrap">Loading…</div><script>setTimeout(function(){var h='<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/login">Sign in</a></nav><h1>Client-rendered test site</h1><p>Everything below was rendered in the browser after load.</p>';for(var i=0;i<30;i++)h+="<p>Section "+(i+1)+". ${P}</p>";document.getElementById("app").innerHTML=h;},500);</script>`),
  // App shell: div-only markup, a tabindex=-1 focus container, an internal scroll container and web components.
  appshell: () => shell("App shell", `<style>html,body{height:100%;overflow:hidden}#scroller{height:100vh;overflow-y:auto}</style>`, `<div id="root" tabindex="-1" style="outline:none"><div id="scroller"><div class="wrap"><div class="nav"><a href="/about">About</a> <a href="/login">Sign in</a></div><x-hero></x-hero>${Array.from({ length: 30 }, (_, i) => `<div class="row"><span>Row ${i + 1}. ${P}</span></div>`).join("")}</div></div></div>
<script>customElements.define("x-hero",class extends HTMLElement{connectedCallback(){this.attachShadow({mode:"open"}).innerHTML="<div style='font-size:28px;font-weight:700'>App-shell test site</div><div>This heading lives inside a web component's shadow DOM.</div>";}});</script>`),
  // Motion: CSS keyframe animation, an animated 2D canvas and lazy-loaded images.
  motion: () => shell("Motion", `<style>@keyframes s{to{transform:rotate(360deg)}}.spin{width:96px;height:96px;background:linear-gradient(135deg,#2a7,#27a);animation:s 3s linear infinite;border-radius:16px}</style>`, `${nav}<main><h1>Motion test site</h1><div class="spin" aria-hidden="true"></div><canvas id="c" width="600" height="200" style="width:100%;max-width:600px;display:block"></canvas>${Array.from({ length: 10 }, (_, i) => `<img loading="lazy" width="600" height="240" style="max-width:100%;height:auto;display:block" alt="Test image ${i + 1}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='240'%3E%3Crect width='600' height='240' fill='%23${(0x204060 + i * 0x0a0a0a).toString(16)}'/%3E%3C/svg%3E"><p>${P}</p>`).join("")}</main>
<script>(function(){var g=document.getElementById("c").getContext("2d"),k=0;function f(){k++;g.fillStyle="#0e1a2e";g.fillRect(0,0,600,200);g.fillStyle="#f6a623";g.beginPath();g.arc(40+(k*3)%520,100,30,0,7);g.fill();requestAnimationFrame(f);}requestAnimationFrame(f);})();</script>`),
  // Negative control: refuses every frame (and is not on any connected account) — must NOT become native.
  refuses: () => shell("Refuses framing", "", `${nav}<main><h1>Framing-refusing test site</h1>${paras(20)}</main>`),
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url), v = VARIANTS[env.VARIANT] ? env.VARIANT : "static";
    const sensitive = url.pathname === "/login";
    const html = sensitive ? shell("Sign in", "", `${nav}<main><h1>Sign in (TEST DATA)</h1><p>There is no sign-in on this test site; this page only proves protected routes keep refusing frames.</p></main>`)
      : url.pathname === "/about" ? shell("About", "", `${nav}<main><h1>About</h1><p>${P}</p></main>`)
      : url.pathname === "/" ? VARIANTS[v]() : null;
    if (html === null) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    const refuse = sensitive || v === "refuses";
    return new Response(html, { headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'self' 'unsafe-inline' data:; frame-ancestors ${refuse ? "'none'" : CRESTMONT}; base-uri 'none'; form-action 'none'`,
      ...(refuse ? { "x-frame-options": "DENY" } : {}),
    } });
  },
};

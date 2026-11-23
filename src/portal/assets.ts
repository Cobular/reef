/**
 * The portal's one stylesheet, one script and favicon, served from the Worker with immutable
 * caching. ASSET_VERSION is part of every URL: change it whenever any of these strings change
 * (test/portal.test.ts checks it against a hash of the content and prints the new value).
 */
export const ASSET_VERSION = "c0723b8743";

export const CSS = `:root{--bg:#F6F3ED;--surface:#FFFFFF;--ink:#0E2A3A;--muted:#5A6A72;--line:#E2DCD1;--sea:#1D6A86;--coral:#C4492F;--ok:#276F4F;--warn:#915D10;--danger:#B42318;--on-solid:#FFFFFF;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0B1A22;--surface:#10242E;--ink:#E6EDF0;--muted:#93A5AD;--line:#1F3744;--sea:#6CC3DD;--coral:#F0806A;--ok:#5CC79A;--warn:#E0A84A;--danger:#F17C70;--on-solid:#0B1A22}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column}
h1,h2{font-weight:600;letter-spacing:-.01em;line-height:1.25;margin:0;overflow-wrap:anywhere}
h1{font-size:22px;letter-spacing:-.015em}h2{font-size:17px}
p{margin:0 0 12px}
a{color:var(--sea);text-underline-offset:2px}
code,.mono{font-family:var(--mono);font-size:.92em}
:focus-visible{outline:2px solid var(--sea);outline-offset:2px;border-radius:4px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:16px;top:-48px;background:var(--surface);padding:8px 12px;border-radius:8px;z-index:9}
.skip:focus{top:8px}
.wrap{width:100%;max-width:64rem;margin:0 auto;padding:0 24px}
.muted{color:var(--muted)}.small{font-size:13px}
.top{background:var(--surface);border-bottom:1px solid var(--line)}
.top-in{display:flex;align-items:center;gap:28px;min-height:60px}
.brand{display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;font-weight:650;font-size:17px;letter-spacing:-.02em}
.brand svg,.empty svg,.drop svg,.facts svg{color:var(--sea)}
.nav{display:flex;gap:4px;overflow-x:auto}
.nav a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:6px;font-weight:500;white-space:nowrap;transition:.14s}
.nav a:hover,.nav a[aria-current=page]{color:var(--ink)}
.nav a[aria-current=page]{background:var(--bg)}
.me{margin-left:auto;display:flex;align-items:center;gap:10px}
form{margin:0}
.main{flex:1;padding-top:32px;padding-bottom:64px}
[tabindex="-1"]:focus{outline:none}
.foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px 20px;padding-bottom:32px;color:var(--muted);font-size:13px}
.foot a{color:var(--muted)}.foot a:hover{color:var(--ink)}
.avatar{position:relative;display:inline-grid;place-items:center;flex:none;width:28px;height:28px;border-radius:50%;background:var(--line);color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;overflow:hidden;vertical-align:middle}
.avatar img{position:absolute;inset:0;width:100%;height:100%}
.avatar.sm{width:22px;height:22px;font-size:10px}
td .avatar{margin-right:6px}
.faces{display:inline-flex;list-style:none;margin:0;padding:0;vertical-align:middle}
.faces li+li{margin-left:-6px}
.faces .avatar{box-shadow:0 0 0 2px var(--surface)}
.who{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px 12px;list-style:none;margin:0;padding:0;vertical-align:middle}
.who li{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere}
.shared{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.head p{margin:6px 0 0;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-weight:600;line-height:20px;padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer;text-decoration:none;white-space:nowrap;transition:.14s}
.btn:hover{border-color:var(--muted)}
.btn.primary,.btn.danger{--c:var(--coral);background:var(--c);border-color:var(--c);color:var(--on-solid)}
.btn.danger{--c:var(--danger)}
.btn.primary:hover,.btn.danger:hover{filter:brightness(1.08)}
.btn.quiet,.btn.quiet-danger{border-color:transparent;background:none;color:var(--muted)}
.btn.quiet:hover{color:var(--ink);background:var(--bg)}
.btn.quiet-danger{color:var(--danger)}
.btn.quiet-danger:hover{background:color-mix(in srgb,var(--danger) 8%,transparent)}
.btn.small{padding:5px 10px;font-size:13px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.pill{--c:var(--muted);display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;line-height:20px;padding:0 9px;border-radius:999px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,var(--surface));white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ready{--c:var(--ok)}.pill.uploading{--c:var(--sea)}.pill.paused,.pill.pending{--c:var(--warn)}
.badge{display:inline-block;min-width:22px;padding:0 7px;border-radius:999px;background:var(--sea);color:var(--on-solid);font-size:13px;font-weight:600;line-height:20px;text-align:center}
.card,.rows{background:var(--surface);border:1px solid var(--line);border-radius:12px}
.card{padding:24px}
.card h1,.card h2{margin-bottom:12px}
.rows{list-style:none;margin:0;padding:0}
.row{display:grid;grid-template-columns:minmax(0,1fr) 11rem auto;gap:12px 24px;align-items:center;padding:16px 20px}
.row.file{grid-template-columns:minmax(0,1fr) 11rem 10rem}
.row.link{position:relative;grid-template-columns:minmax(0,1fr) auto}
.row.link .row-title a::after{content:"";position:absolute;inset:0;border-radius:8px}
.row.link .row-title a:focus-visible{outline:none}
.row.link .row-title a:focus-visible::after{outline:2px solid var(--sea);outline-offset:-2px}
.row+.row{border-top:1px solid var(--line)}
.row-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.row-desc{margin:0 0 4px;color:var(--muted);font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row>div:first-child{min-width:0}
.row-title a{color:var(--ink);font-weight:600;text-decoration:none;overflow-wrap:anywhere}
.row-title a:hover{text-decoration:underline}
.gone .row-title a{color:var(--muted)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;color:var(--muted);font-size:13px}
.row-actions{display:flex;align-items:center;gap:4px;justify-content:flex-end}
.left{display:block;font-size:13px;color:var(--muted);margin-top:6px;font-variant-numeric:tabular-nums}
.low .left{color:var(--warn)}
.tide,.bar{height:4px;border-radius:2px;background:color-mix(in srgb,var(--sea) 16%,transparent);overflow:hidden}
.tide span,.bar span{display:block;height:100%;background:var(--sea);transition:width .15s linear}
.low .tide span{background:var(--warn)}
${Array.from({ length: 21 }, (_, i) => `.w${i * 5}{width:${i * 5}%}`).join("")}
.confirm{position:relative}
.confirm>summary{list-style:none}
.confirm>summary::-webkit-details-marker{display:none}
.confirm-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:5;width:17rem;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;box-shadow:0 8px 24px rgb(0 0 0/.12)}
.confirm-panel p{font-size:13px;color:var(--muted);white-space:normal;text-align:left}
.confirm.inline .confirm-panel{position:static;margin-top:8px;width:auto;box-shadow:none}
.flash{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:8px;padding:12px 16px;margin-bottom:24px}
.flash.error{border-left-color:var(--danger)}.flash.info{border-left-color:var(--sea)}.flash.warn{border-left-color:var(--warn)}
.flash p{margin:0}
.empty{text-align:center;padding:56px 24px}
.empty svg{margin-bottom:12px}
.empty .lead{font-size:17px;font-weight:600;margin-bottom:6px}
.empty .muted{max-width:30rem;margin:0 auto 20px}
.copy{display:flex;gap:8px;align-items:flex-start}
.copy code{flex:1;min-width:0;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;font-size:13px;line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap;user-select:all;-webkit-user-select:all}
.copy.lg code{font-size:14px;padding:14px 16px}
.field{margin:0 0 22px;border:0;padding:0;min-width:0}
label,legend{display:block;font-weight:600;margin-bottom:6px;padding:0}
.opt{font-weight:400;color:var(--muted)}
.hint{color:var(--muted);font-size:13px;margin:6px 0 0}
.field-error{color:var(--danger);font-size:13px;font-weight:500;margin:6px 0 0}
input[type=text],input[type=number],textarea{width:100%;font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:9px 12px;transition:border-color .14s}
textarea{display:block;resize:vertical;min-height:4.5em}
input[type=text]:hover,input[type=number]:hover,textarea:hover{border-color:var(--muted)}
input:focus-visible,textarea:focus-visible{outline:2px solid var(--sea);outline-offset:0;border-color:var(--sea)}
[aria-invalid=true]{border-color:var(--danger)!important}
input.short{max-width:10rem}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin:0 0 8px}
.check input{margin:3px 0 0;accent-color:var(--sea)}
.check small{display:block;color:var(--muted);font-size:13px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}
.seg input{position:absolute;opacity:0}
.seg label{margin:0;padding:8px 16px;font-weight:500;cursor:pointer;color:var(--muted);white-space:nowrap;transition:.14s}
.seg label+input+label{border-left:1px solid var(--line)}
.seg input:checked+label{background:var(--ink);color:var(--surface)}
.seg input:focus-visible+label{outline:2px solid var(--sea);outline-offset:-2px}
.drop{border:1.5px dashed var(--line);border-radius:12px;padding:28px 20px;text-align:center;background:var(--bg);transition:.14s}
.drop.over{border-color:var(--sea);background:color-mix(in srgb,var(--sea) 8%,var(--bg))}
.drop input{display:block;margin:12px auto 0;max-width:100%;font:inherit;font-size:13px;color:var(--muted)}
.drop input::file-selector-button{font:inherit;font-weight:600;margin-right:10px;padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);cursor:pointer}
.chosen{font-weight:600;margin:10px 0 0;overflow-wrap:anywhere}
.bar{height:6px;margin:16px 0 10px}
.bar span{width:0}
.progress-row{display:flex;justify-content:space-between;align-items:center;gap:12px;font-variant-numeric:tabular-nums}
.stack>*+*{margin-top:24px}
.narrow{max-width:40rem}
.note{background:color-mix(in srgb,var(--warn) 10%,var(--surface));border-radius:8px;padding:12px 14px;font-size:13px}
.kv{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:12px 16px;margin:0}
.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0}
.title-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.title-row>h1{margin:0}
.school-desc{margin:-12px 0 24px;max-width:48rem;color:var(--muted);white-space:pre-line;overflow-wrap:anywhere}
.people{list-style:none;margin:0;padding:0}
.people li{display:flex;align-items:center;gap:10px;padding:6px 0}
.people form{margin-left:auto}
.inline-form{display:flex;gap:8px;align-items:flex-start}
.inline-form>div{flex:1}
.split{display:grid;grid-template-columns:minmax(0,1fr) 19rem;gap:32px;align-items:start}
.panel{display:grid;gap:16px}
.panel .card{padding:18px}
.panel h2{font-size:15px}
.banner{background:color-mix(in srgb,var(--warn) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--warn) 35%,var(--line));border-radius:12px;padding:16px 20px;margin-bottom:24px}
.banner strong{font-size:17px}
.banner p{margin:4px 0 0}
.msgs{list-style:none;margin:0;padding:0}
.msg{display:grid;grid-template-columns:32px minmax(0,1fr);gap:12px;padding:14px 16px;border-left:3px solid transparent}
.msg+.msg{border-top:1px solid var(--line)}
.msg.other{border-left-color:var(--sea)}
.msg .avatar{width:32px;height:32px}
.msg-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:13px;color:var(--muted)}
.msg-head strong{color:var(--ink);font-size:15px}
.msg-text{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0}
.divider{display:flex;align-items:center;gap:10px;padding:4px 16px;color:var(--sea);font-size:13px;font-weight:600}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:color-mix(in srgb,var(--sea) 55%,transparent)}
.chip,.file-chip{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--line);border-radius:999px;font-size:13px;line-height:20px;color:var(--muted);white-space:nowrap}
.tag{font-size:13px;color:var(--muted)}
.attach{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0;padding:0}
.file-chip{padding:4px 10px;border-radius:8px;background:var(--bg);color:var(--ink);text-decoration:none;white-space:normal}
a.file-chip:hover{border-color:var(--sea)}
.file-chip.gone{color:var(--muted)}
.pager{display:flex;justify-content:center;padding:12px}
.msg.person{background:var(--bg)}
.msg:target{border-left-color:var(--coral)}
.reply-link{margin-left:auto;color:var(--muted)}
.reply-link:hover{color:var(--sea)}
.msg-reply{margin:4px 0 0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.msg-reply a{color:var(--muted)}
.reply-chip{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;margin:0 0 8px;padding:6px 12px;border:1px solid var(--line);border-left:3px solid var(--sea);border-radius:8px;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.compose{border-top:1px solid var(--line);margin-top:8px;padding:16px 16px 0}
.compose-foot{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 16px;margin-top:8px}
.compose-foot .hint{margin:0;flex:1 1 14rem}
.count{font-variant-numeric:tabular-nums;white-space:nowrap}
.count.over{color:var(--danger);font-weight:600}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-top:1px solid var(--line)}
th{font-size:13px;color:var(--muted);border-top:0}
td:last-child,th:last-child{text-align:right}
.section-gap{margin-top:40px}
.past>summary{cursor:pointer;color:var(--muted);font-weight:600;padding:8px 0;margin-bottom:8px}
.connect-panel{max-width:40rem}
.connect-panel .copy{margin-bottom:8px}
.landing{padding-bottom:16px}
.hero{max-width:46rem;padding:48px 0 48px}
.hero h1{font-size:42px;line-height:1.1;letter-spacing:-.035em;margin-bottom:16px}
.lede{font-size:18px;color:var(--muted);margin-bottom:28px;max-width:40rem}
.hero-actions{display:flex;flex-wrap:wrap;gap:8px}
.facts svg,.demo-name svg{flex:none;color:var(--sea)}
.half{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:56px;align-items:center;padding:64px 0;border-top:1px solid var(--line);scroll-margin-top:16px}
.half.flip .demo{order:-1}
.kicker{color:var(--coral);font-size:13px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
.half h2,.connect h2{font-size:28px;letter-spacing:-.025em;margin-bottom:12px}
.half-lede{font-size:16px;color:var(--muted)}
.stories{list-style:none;margin:24px 0;padding:0;display:grid;gap:16px}
.stories li{padding-left:14px;border-left:2px solid color-mix(in srgb,var(--sea) 35%,var(--line))}
.stories h3{font-size:15px;font-weight:600;margin:0 0 2px}
.stories p{margin:0;color:var(--muted)}
.facts{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.facts li{display:flex;gap:12px}
.facts svg{margin-top:2px}
.demo{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgb(14 42 58/.05),0 18px 40px -18px rgb(14 42 58/.28)}
.demo-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--bg)}
.demo-name{display:inline-flex;align-items:center;gap:8px;min-width:0;font-weight:600;font-size:14px;overflow-wrap:anywhere}
.demo .msg{padding:12px 16px}
.demo .msg-text{margin-top:4px}
.demo-a,.demo-b,.demo-c{--c:var(--sea);background:color-mix(in srgb,var(--c) 18%,var(--surface));color:var(--c)}
.demo-b{--c:var(--coral)}.demo-c{--c:var(--ok)}
.demo-body{padding:18px 16px}
.demo .kv{grid-template-columns:7rem minmax(0,1fr);gap:6px 12px}
.demo-tide{margin:18px 0 20px}
.demo-label{margin:0 0 6px}
.demo-code{display:block;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;font-size:12.5px;line-height:1.6;overflow-wrap:anywhere}
.connect{max-width:44rem;padding:64px 0 0;border-top:1px solid var(--line);scroll-margin-top:16px}
.connect h2{margin-bottom:24px}
.steps{list-style:none;counter-reset:step;margin:0 0 32px;padding:0;display:grid;gap:22px}
.steps li{counter-increment:step;position:relative;padding-left:42px;color:var(--muted)}
.steps li::before{content:counter(step);position:absolute;left:0;top:-1px;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--ink);color:var(--bg);font-size:13px;font-weight:650}
.steps strong{display:block;color:var(--ink)}
.steps .copy{margin-top:12px}
@media (max-width:720px){.wrap{padding:0 16px}.top-in{flex-wrap:wrap;gap:0 16px;padding-top:10px}.nav{order:3;width:100%;margin:6px -10px 4px}.me-login{display:none}.main{padding-top:24px}.row{grid-template-columns:1fr;gap:12px;padding:16px}.row.file,.row.link{grid-template-columns:1fr}.row-actions{justify-content:flex-start}.row.file .row-actions{justify-content:flex-end}.confirm-panel{right:auto;left:0}.row.file .confirm-panel{left:auto;right:0}.split{grid-template-columns:1fr}.kv{grid-template-columns:1fr;gap:2px}.kv dd{margin-bottom:10px}.copy{flex-direction:column;align-items:stretch}.hero{padding:16px 0 40px}.hero h1{font-size:32px}.lede{font-size:17px}@media (max-width:420px){.seg label{padding:8px 10px;font-size:14px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export const JS = `(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const live = $("#live");
  const say = (text) => { if (live) { live.textContent = ""; setTimeout(() => { live.textContent = text; }, 50); } };

  // ---- time --------------------------------------------------------------------------------
  function rel(ms, now) {
    const d = ms - now, a = Math.abs(d), m = Math.round(a / 60000), h = Math.round(a / 3600000);
    let t;
    if (a < 45000) return "just now";
    if (m < 60) t = m + " min";
    else if (h < 24) t = h + " h";
    else if (h < 48) return d < 0 ? "yesterday" : "tomorrow";
    else t = Math.round(a / 86400000) + " days";
    return d < 0 ? t + " ago" : "in " + t;
  }
  function left(ms) {
    const s = Math.ceil(ms / 1000);
    if (s <= 0) return "Expired";
    if (s < 60) return s + " s left";
    if (s < 120) return "1 min left";
    return Math.ceil(s / 60) + " min left";
  }
  function clocks() {
    for (const t of $$("time[data-clock]")) {
      const ms = Date.parse(t.dateTime);
      if (isNaN(ms)) continue;
      t.textContent = new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      t.title = new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
    }
  }
  function tick() {
    const now = Date.now();
    for (const t of $$("time[data-rel]")) t.textContent = rel(Date.parse(t.dateTime), now);
    for (const el of $$("[data-end]")) {
      const end = Number(el.dataset.end), total = Number(el.dataset.total) || 1, rest = end - now;
      const bar = $(".tide span", el), txt = $(".left", el);
      if (bar) bar.style.width = Math.max(0, Math.min(100, (rest / total) * 100)) + "%";
      if (txt) txt.textContent = left(rest);
      el.classList.toggle("low", rest < 120000);
    }
  }
  clocks();
  tick();
  setInterval(tick, 1000);

  // ---- copy buttons and confirm panels -------------------------------------------------------
  let guarded = false;
  const guard = (e) => { if (guarded) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", guard);
  for (const b of $$("[data-copy]")) b.hidden = false;
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    const src = document.getElementById(b.dataset.copy);
    if (!src) return;
    try {
      await navigator.clipboard.writeText(src.textContent);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(src);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("copy");
    }
    if (b.hasAttribute("data-guard")) guarded = false;
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.textContent = "Copied";
    say("Copied to the clipboard.");
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.textContent = b.dataset.label; }, 2000);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const d of $$("details.confirm[open]")) { d.open = false; $("summary", d).focus(); }
  });

  // ---- school compose: byte counter, Ctrl/Cmd+Enter sends -----------------------------------
  for (const ta of $$("textarea[data-max-bytes]")) {
    const max = Number(ta.dataset.maxBytes), out = document.getElementById(ta.dataset.count);
    const enc = new TextEncoder();
    const count = () => {
      const n = enc.encode(ta.value).length;
      out.textContent = n.toLocaleString() + " of " + max.toLocaleString() + " bytes";
      out.classList.toggle("over", n > max);
    };
    if (out) { out.hidden = false; count(); ta.addEventListener("input", count); }
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ta.form) { e.preventDefault(); ta.form.requestSubmit(); }
    });
  }

  // ---- upload --------------------------------------------------------------------------------
  const form = $("#upload");
  if (!form) return;
  const input = $("#file"), drop = $("#drop"), go = $("#upload-go"), chosen = $("#chosen");
  const progress = $("#progress"), fill = $(".bar span", progress), ptext = $("#progress-text");
  const plive = $("#progress-live");
  let xhr = null, cancelled = false, created = null;
  go.disabled = false;

  function size(n) {
    const u = ["bytes", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < 3) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
  }
  function showFile() {
    const f = input.files[0];
    chosen.hidden = !f;
    if (f) chosen.textContent = f.name + " · " + size(f.size);
  }
  input.addEventListener("change", showFile);
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; showFile(); clearErrors(); }
  });

  function clearErrors() {
    for (const el of $$(".field-error", form)) { el.hidden = true; el.textContent = ""; }
    for (const el of $$("[aria-invalid]", form)) el.removeAttribute("aria-invalid");
    $("#form-error").hidden = true;
  }
  function showError(field, message) {
    const el = $("#" + field + "-error");
    const target = el || $("#form-error");
    target.textContent = message;
    target.hidden = false;
    const control = form.elements[field];
    if (el && control && control.setAttribute) { control.setAttribute("aria-invalid", "true"); control.focus(); }
    else target.focus();
  }
  function busy(on) {
    for (const el of $$("input, button[type=submit]", form)) el.disabled = on;
    progress.hidden = !on;
    guarded = on;
  }
  function report(sent, total) {
    const pct = total ? Math.floor((sent / total) * 100) : 100;
    fill.style.width = pct + "%";
    ptext.textContent = size(sent) + " of " + size(total) + " · " + pct + "%";
    const step = Math.floor(pct / 25) * 25;
    if (step !== report.last) { report.last = step; plive.textContent = "Uploaded " + step + " percent."; }
  }
  function send(method, url, body, onProgress) {
    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader("X-Key", created.key);
      if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => (xhr.status < 300 ? resolve(xhr.responseText) : reject(new Error(xhr.responseText.trim() || "Upload failed (" + xhr.status + ").")));
      xhr.onerror = () => reject(new Error("The connection dropped. Check your network and try again."));
      xhr.onabort = () => reject(new Error("cancelled"));
      xhr.send(body);
    });
  }
  async function sendPart(url, body, onProgress) {
    for (let attempt = 0; ; attempt++) {
      try { return await send("PUT", url, body, onProgress); }
      catch (err) { if (cancelled || attempt >= 2 || !/connection/.test(err.message)) throw err; }
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    const file = input.files[0];
    if (!file) return showError("file", "Choose a file to upload.");
    const fields = new URLSearchParams(new FormData(form));
    fields.delete("file");
    fields.set("name", file.name);
    fields.set("size", String(file.size));
    cancelled = false;
    report.last = -1;
    busy(true);
    report(0, file.size);
    try {
      const res = await fetch(form.action, { method: "POST", body: fields, headers: { Accept: "application/json" }, credentials: "same-origin" });
      const data = await res.json().catch(() => ({ error: { message: "Reef could not start the upload. Try again." } }));
      if (!res.ok) { busy(false); const er = data.error || {}; return showError(er.field || "form", er.message || "Reef could not start the upload."); }
      created = data;
      const base = "/up/" + data.token;
      let done = "";
      if (data.parts <= 1) {
        done = await sendPart(base, file, (n) => report(n, file.size));
      } else {
        for (let n = 1; n <= data.parts; n++) {
          const start = (n - 1) * data.partSize;
          await sendPart(base + "/" + n, file.slice(start, Math.min(file.size, start + data.partSize)), (sent) => report(start + sent, file.size));
        }
        done = await send("POST", base + "/complete", null);
      }
      report(file.size, file.size);
      finish(data, done);
    } catch (err) {
      busy(false);
      if (created) fetch("/files/" + created.fileId + "/delete", { method: "POST", body: new URLSearchParams({ csrf: form.elements.csrf.value }), credentials: "same-origin" }).catch(() => {});
      created = null;
      if (cancelled) { say("Upload cancelled."); return; }
      showError("form", err.message);
    }
  });
  $("#cancel").addEventListener("click", () => { cancelled = true; if (xhr) xhr.abort(); });

  function finish(data, done) {
    const m = /It expires (\\S+Z)\\.\\s*$/.exec(done);
    const end = m ? Date.parse(m[1]) : Date.now() + data.lifetimeMinutes * 60000;
    const iso = new Date(end).toISOString().replace(/\\.\\d{3}Z$/, "Z");
    const result = $("#result");
    $("#handoff").textContent = data.handoff.replace(/expires=\\S+$/, "expires=" + iso);
    $("#key").textContent = data.key;
    $("[data-slot=name]", result).textContent = data.name;
    $("[data-slot=link]", result).href = "/files/" + data.fileId;
    const timer = $(".timer", result);
    timer.dataset.end = String(end);
    timer.dataset.total = String(data.lifetimeMinutes * 60000);
    const t = $("time", result);
    t.dateTime = iso;
    form.hidden = true;
    result.hidden = false;
    guarded = true;
    clocks();
    tick();
    $("#result-title").focus();
    say("Upload finished. Copy the handoff line before you leave this page.");
  }
})();
`;

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0E2A3A"/><path d="M6 13c2.5 0 2.5-2.5 5-2.5s2.5 2.5 5 2.5 2.5-2.5 5-2.5 2.5 2.5 5 2.5M6 20c2.5 0 2.5-2.5 5-2.5s2.5 2.5 5 2.5 2.5-2.5 5-2.5 2.5 2.5 5 2.5" fill="none" stroke="#6CC3DD" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const IMMUTABLE = "public, max-age=31536000, immutable";

const FILES: Record<string, { body: string; type: string }> = {
  [`/static/portal.${ASSET_VERSION}.css`]: { body: CSS, type: "text/css; charset=utf-8" },
  [`/static/portal.${ASSET_VERSION}.js`]: {
    body: JS,
    type: "text/javascript; charset=utf-8",
  },
  [`/static/favicon.${ASSET_VERSION}.svg`]: { body: FAVICON, type: "image/svg+xml" },
};

export const ASSET_URLS = {
  css: `/static/portal.${ASSET_VERSION}.css`,
  js: `/static/portal.${ASSET_VERSION}.js`,
  favicon: `/static/favicon.${ASSET_VERSION}.svg`,
};

/** Serves a static asset, or null if the path is not one (including an old version). */
export function serveAsset(pathname: string): Response | null {
  const file = FILES[pathname];
  if (!file) return null;
  return new Response(file.body, {
    headers: {
      "Content-Type": file.type,
      "Cache-Control": IMMUTABLE,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * /favicon.ico, for clients that ask for it without reading the page: the SVG itself under a
 * day's cache, not a redirect, so a cached answer never points at an old versioned URL.
 */
export function serveFaviconIco(): Response {
  return new Response(FAVICON, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

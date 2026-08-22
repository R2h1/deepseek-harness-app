/**
 * Mobile Access UI — served by the shell's status server at /mobile.
 *
 * A self-contained page (no external network): it loads the vendored qrcode lib from
 * /qrcode.min.js, polls /status for the LAN URL / tunnel state, and renders QR codes
 * client-side. All logic lives in the shell; this page is a thin viewer/controller.
 */

export function mobileUiHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>手机访问 · Mobile Access</title>
<style>
  :root { --bg:#0f1115; --card:#1a1d24; --fg:#e6e8ee; --muted:#8a8f98; --accent:#4f6ef7; --ok:#34d399; --err:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; padding:20px; }
  h1 { font-size:17px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:12px; margin:0 0 16px; }
  .card { background:var(--card); border:1px solid #262a33; border-radius:12px; padding:16px; margin-bottom:14px; }
  .card h2 { font-size:13px; margin:0 0 10px; color:var(--muted); font-weight:600; }
  .qrwrap { text-align:center; padding:10px 0 4px; }
  .qrwrap img { width:200px; height:200px; background:#fff; border-radius:8px; padding:8px; }
  .url { font-size:12px; word-break:break-all; color:var(--muted); margin:8px 0 10px; text-align:center; }
  .btn { display:inline-block; width:100%; padding:10px; font-size:14px; border:none; border-radius:8px; cursor:pointer; background:var(--accent); color:#fff; }
  .btn:disabled { opacity:.5; cursor:default; }
  .btn.off { background:#333; }
  .status { font-size:12px; color:var(--muted); margin-top:8px; text-align:center; }
  .status.ok { color:var(--ok); }
  .status.err { color:var(--err); }
  .warn { font-size:12px; color:#fbbf24; background:#2a2416; border:1px solid #4a3d1a; border-radius:8px; padding:10px 12px; margin-top:6px; }
  .pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; margin-left:6px; }
  .pill.on { background:#123d2c; color:var(--ok); }
  .pill.off { background:#3a1f1f; color:var(--err); }
  .pinrow { display:flex; align-items:center; gap:8px; justify-content:center; margin:6px 0 10px; font-size:13px; }
  .pinrow b { font-size:22px; letter-spacing:4px; color:var(--fg); }
  .linkbtn { background:none; border:1px solid #333; color:var(--muted); border-radius:6px; padding:3px 10px; font-size:12px; cursor:pointer; }
  .linkbtn:hover { color:var(--fg); }
</style>
</head>
<body>
  <h1>📱 手机访问</h1>
  <p class="sub">手机扫码，实时访问电脑上的 DeepSeek Harness</p>

  <div class="card">
    <h2>局域网（同一 WiFi）<span class="pill" id="lanPill">…</span></h2>
    <div class="qrwrap" id="lanQr"><div class="status">正在获取地址…</div></div>
    <div class="url" id="lanUrl"></div>
    <button class="btn" id="lanCopy">复制地址</button>
  </div>

  <div class="card">
    <h2>公网 / IPv6（人在外面，免服务器）<span class="pill" id="ipv6Pill">…</span></h2>
    <div class="qrwrap" id="ipv6Qr"><div class="status">未检测到 IPv6</div></div>
    <div class="url" id="ipv6Url"></div>
    <button class="btn" id="ipv6Copy">复制 IPv6 地址</button>
    <div class="pinrow" id="pinRow" style="display:none">
      <span>访问 PIN：</span><b id="pinVal"></b>
      <button class="linkbtn" id="pinRotate">重新生成</button>
    </div>
    <div class="warn">🔒 公网/IPv6 访问需要输入上面的 8 位 PIN（局域网 WiFi 免密）。PIN 就是钥匙——不要泄露。</div>
  </div>

  <div class="card">
    <h2>公网隧道（cloudflared）<span class="pill" id="pubPill">…</span></h2>
    <div class="qrwrap" id="pubQr"><div class="status">未开启</div></div>
    <div class="url" id="pubUrl"></div>
    <button class="btn off" id="pubBtn">开启公网</button>
    <div class="status" id="pubState"></div>
  </div>

  <div class="warn">⚠️ 二维码和链接就是钥匙——<b>不要发给任何人</b>。它可以让对方直接操作你电脑上的 Harness（可执行代码）。同一 WiFi 下任何拿到链接的设备都能进入；关闭应用即停止访问。</div>

<script src="/qrcode.min.js"></script>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var qrTimer = null;

  function renderQr(hostEl, url) {
    if (!url) { hostEl.innerHTML = '<div class="status">未就绪</div>'; return; }
    hostEl.innerHTML = '';
    try {
      var qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      var img = document.createElement('img');
      img.src = qr.createDataURL(4, 4);
      img.alt = url;
      hostEl.appendChild(img);
    } catch (e) {
      hostEl.innerHTML = '<div class="status err">二维码生成失败：' + e + '</div>';
    }
  }

  function setText(id, text) { $(id).textContent = text || ''; }

  function update(data) {
    // LAN
    var lanUp = data.proxyRunning && data.lanUrl;
    setText('lanUrl', data.lanUrl || '');
    $('lanPill').textContent = lanUp ? '已开启' : '未开启';
    $('lanPill').className = 'pill ' + (lanUp ? 'on' : 'off');
    if (lanUp) renderQr($('lanQr'), data.lanUrl);
    else $('lanQr').innerHTML = '<div class="status">代理未运行</div>';
    $('lanCopy').disabled = !data.lanUrl;

    // Public (cloudflared tunnel)
    var t = data.tunnel || {};
    var pubUrl = t.url || '';
    setText('pubUrl', pubUrl);
    $('pubPill').textContent = t.running ? '运行中' : '关闭';
    $('pubPill').className = 'pill ' + (t.running ? 'on' : 'off');
    if (pubUrl) renderQr($('pubQr'), pubUrl);
    else $('pubQr').innerHTML = '<div class="status">未开启</div>';
    var busy = t.phase === 'starting' || t.phase === 'downloading' || t.phase === 'registering';
    var btn = $('pubBtn');
    btn.disabled = busy;
    btn.textContent = t.running ? '关闭公网' : (busy ? '开启中…' : '开启公网');
    btn.className = 'btn' + (t.running ? '' : ' off');
    var st = t.phase === 'idle' ? '' : (t.detail || t.phase);
    var cls = t.phase === 'error' ? 'err' : (t.phase === 'ready' ? 'ok' : '');
    $('pubState').textContent = st;
    $('pubState').className = 'status ' + cls;

    // PIN (public access gate)
    var pin = data.pin && data.pinEnabled ? data.pin : null;
    $('pinRow').style.display = pin ? 'flex' : 'none';
    if (pin) $('pinVal').textContent = pin;

    // IPv6 public (self-hosted, PIN-gated)
    var ipv6 = data.ipv6Url || '';
    setText('ipv6Url', ipv6);
    $('ipv6Pill').textContent = ipv6 ? '可访问' : '无 IPv6';
    $('ipv6Pill').className = 'pill ' + (ipv6 ? 'on' : 'off');
    if (ipv6) renderQr($('ipv6Qr'), ipv6);
    else $('ipv6Qr').innerHTML = '<div class="status">未检测到公网 IPv6（4G 测试需要它）</div>';
    $('ipv6Copy').disabled = !ipv6;
  }

  function poll() {
    fetch('/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject('status ' + r.status); })
      .then(update)
      .catch(function (e) {
        $('lanQr').innerHTML = '<div class="status err">无法连接本地服务：' + e + '</div>';
      });
  }

  $('pinRotate').addEventListener('click', function () {
    fetch('/pin/rotate', { method: 'POST', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.pin) $('pinVal').textContent = j.pin; })
      .catch(function () { /* best-effort */ });
  });

  $('ipv6Copy').addEventListener('click', function () {
    var url = $('ipv6Url').textContent;
    if (!url) return;
    if (navigator.clipboard) navigator.clipboard.writeText(url);
    var b = this; var old = b.textContent;
    b.textContent = '已复制 ✓';
    setTimeout(function () { b.textContent = old; }, 1200);
  });

  $('lanCopy').addEventListener('click', function () {
    var url = $('lanUrl').textContent;
    if (!url) return;
    if (navigator.clipboard) navigator.clipboard.writeText(url);
    var b = this; var old = b.textContent;
    b.textContent = '已复制 ✓';
    setTimeout(function () { b.textContent = old; }, 1200);
  });

  $('pubBtn').addEventListener('click', function () {
    var b = this;
    if (b.disabled) return;
    var turningOn = b.textContent.indexOf('开启') === 0;
    fetch(turningOn ? '/tunnel/start' : '/tunnel/stop', { method: 'POST', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.error) {
          $('pubState').textContent = '出错：' + j.error;
          $('pubState').className = 'status err';
        } else {
          poll();
        }
      })
      .catch(function (e) {
        $('pubState').textContent = '请求失败：' + e;
        $('pubState').className = 'status err';
      });
  });

  poll();
  setInterval(poll, 2000);
})();
</script>
</body>
</html>`;
}

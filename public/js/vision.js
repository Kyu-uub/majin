/* Majin — Vision overlay logic (v36).
   A self-contained client for the always-on-top floating pill (vision.html). It is
   hosted either in a transparent Electron window or, in a browser, inside a Document
   Picture-in-Picture window (see js/app.js openVisionOverlay). It:
   • grabs the real screen via getDisplayMedia and keeps a live self-view,
   • on every send it attaches the CURRENT frame so the model genuinely LOOKS,
   • tells the model to read the screenshot and give on-screen coordinates
     instead of firing shell / OCR commands to "find out" what is visible,
   • streams the answer back (SSE from /api/agent) into the compact card, and
   • auto-approves the model's own click/type actions so it can actually locate
     and interact with what it sees.
   CSP is script-src 'self' — no inline handlers; everything wired here. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const IS_ELECTRON = /electron/i.test(String(navigator.userAgent || ''));

  const els = {
    root: $('vroot'), log: $('vlog'), bar: $('vbar'), input: $('vin'),
    thumb: $('vthumb'), title: $('vtitle'), sub: $('vsub'),
    share: $('vshare'), shareLabel: $('vshareLabel'), see: $('vsee'),
    send: $('vsend'), close: $('vclose')
  };

  const MAX_W = 1280;                     // downscale frames for upload
  const S = { history: [], busy: false, abort: null, raw: '', aiLine: null,
    stream: null, track: null, canvas: null, ctx: null, active: false, screenW: 0, screenH: 0,
    token: null, logOpen: false };

  /* ---------- token (same CSRF scheme as the main app) ---------- */
  async function ensureToken() {
    if (S.token) return S.token;
    try { const r = await fetch('/api/boot'); S.token = (await r.json()).token || null; } catch (e) {}
    return S.token;
  }
  async function postJSON(url, body) {
    const tok = await ensureToken();
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Majin-Token': tok || '' }, body: JSON.stringify(body || {}) });
  }

  /* ---------- keep the floating window sized to its content (PiP / popup) ----------
     In Electron the OS window is fixed-size + transparent, so we never resize there.
     In a browser Picture-in-Picture (or popup) window we grow/shrink the window so it
     hugs the pill + answer card instead of leaving dead space. */
  let fitQueued = false;
  function fitWindow() {
    if (IS_ELECTRON) return;
    if (fitQueued) return; fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      try {
        const barH = els.bar.offsetHeight || 108;
        const logH = els.log.hidden ? 0 : Math.min(els.log.scrollHeight + 2, 300);
        const h = Math.ceil(barH + logH + (logH ? 8 : 0) + 20);
        const w = window.outerWidth || els.root.offsetWidth || 560;
        try { window.resizeTo(Math.max(360, Math.min(720, w)), Math.max(96, Math.min(560, h))); } catch (e) {}
      } catch (e) {}
    });
  }

  /* ---------- log rendering ---------- */
  function show() { if (els.log.hidden) { els.log.hidden = false; S.logOpen = true; fitWindow(); } }
  function addLine(kind, who, html) {
    const d = document.createElement('div'); d.className = 'vline ' + kind;
    d.innerHTML = '<div class="who">' + esc(who) + '</div><div class="vbody">' + html + '</div>';
    els.log.appendChild(d); trim(); els.log.scrollTop = els.log.scrollHeight; fitWindow(); return d;
  }
  function addSys(text) { const d = document.createElement('div'); d.className = 'vline sys'; d.textContent = text; els.log.appendChild(d); trim(); els.log.scrollTop = els.log.scrollHeight; fitWindow(); return d; }
  function trim() { while (els.log.children.length > 60) els.log.removeChild(els.log.firstChild); }
  const md = t => { let h; try { h = marked.parse(String(t == null ? '' : t)); } catch (e) { return esc(t); } try { if (window.DOMPurify) h = DOMPurify.sanitize(h); } catch (e) {} return h; };

  /* ---------- capture ---------- */
  async function startCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { addSys('Screen capture needs Chrome / Edge or the desktop app.'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
    catch (e) {
      const n = (e && e.name) || '';
      if (n !== 'NotAllowedError') addSys('Could not capture screen' + (n ? ' (' + n + ')' : '') + '.');
      return;
    }
    S.stream = stream; S.track = stream.getVideoTracks()[0] || null;
    els.thumb.srcObject = stream;
    try { await els.thumb.play(); } catch (e) {}
    els.thumb.addEventListener('loadedmetadata', () => { S.screenW = els.thumb.videoWidth || 0; S.screenH = els.thumb.videoHeight || 0; });
    S.screenW = els.thumb.videoWidth || S.screenW; S.screenH = els.thumb.videoHeight || S.screenH;
    S.canvas = document.createElement('canvas'); S.ctx = S.canvas.getContext('2d');
    if (S.track) S.track.addEventListener('ended', stopCapture);
    S.active = true; paintShare();
    addSys('Sharing your screen — ask away. Majin will look at it, not run commands to guess.');
  }
  function stopCapture() {
    S.active = false;
    try { if (S.track) S.track.removeEventListener('ended', stopCapture); } catch (e) {}
    try { if (S.stream) for (const t of S.stream.getTracks()) t.stop(); } catch (e) {}
    try { els.thumb.srcObject = null; } catch (e) {}
    S.stream = null; S.track = null; S.canvas = null; S.ctx = null; paintShare();
  }
  function grabFrame() {
    if (!S.active || !els.thumb || !S.ctx) return null;
    const vw = els.thumb.videoWidth || 0, vh = els.thumb.videoHeight || 0;
    if (!vw || !vh) return null;
    S.screenW = vw; S.screenH = vh;
    const scale = Math.min(1, MAX_W / vw), w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
    S.canvas.width = w; S.canvas.height = h;
    try { S.ctx.drawImage(els.thumb, 0, 0, w, h); } catch (e) { return null; }
    let url = ''; try { url = S.canvas.toDataURL('image/jpeg', 0.72); } catch (e) { return null; }
    const comma = url.indexOf(','); if (comma < 0) return null;
    return { mime: 'image/jpeg', data: url.slice(comma + 1), preview: url };
  }
  function setIcon(el, name) { try { el.innerHTML = '<i data-lucide="' + name + '"></i>'; if (window.lucide) lucide.createIcons(); } catch (e) {} }
  function paintShare() {
    els.root.classList.toggle('sharing', S.active);
    els.sub.textContent = S.active ? 'Sharing your screen · Majin can see it' : 'Not sharing your screen';
    els.shareLabel.textContent = S.active ? 'Stop' : 'Share';
    els.share.title = S.active ? 'Stop sharing' : 'Share your screen';
    setIcon(els.share, S.active ? 'screen-share-off' : 'screen-share');
    els.see.classList.toggle('live', S.active);
    els.see.title = S.active ? 'Majin can see your screen — click to hide/show the answer' : 'Share your screen so Majin can see';
  }

  /* ---------- send a turn (with the live frame the model must READ) ---------- */
  function buildDirective(frame) {
    if (!frame) return '';
    return '\n\n[Screen: the attached image IS the user\'s live desktop RIGHT NOW, ' + S.screenW + '×' + S.screenH +
      ' pixels. Answer by LOOKING at this image — do NOT run run_command, ocr_screen, screenshot or file tools to discover what you can already see in the picture. ' +
      'Describe positions relative to the frame (e.g. "top-left", "the blue button near the bottom"). To interact, call click/type with REAL on-screen pixel coordinates derived from the image (x in 0..' + S.screenW + ', y in 0..' + S.screenH + '), not percentages.]';
  }

  function send() {
    if (S.busy) return;
    const userText = String(els.input.value || '').trim();
    const frame = S.active ? grabFrame() : null;
    if (!userText && !frame) return;
    const message = userText + (frame ? buildDirective(frame) : '');
    const shownBody = userText || 'What do you see on my screen?';

    // Echo the user line (with the little frame thumbnail we captured).
    show();
    const you = addLine('you', 'You', esc(shownBody));
    if (frame) { const im = document.createElement('img'); im.src = frame.preview; im.alt = 'screen'; you.querySelector('.vbody').appendChild(im); }
    els.input.value = '';

    const images = frame ? [{ mime: frame.mime, data: frame.data }] : [];
    runTurn(message, images, !!frame);
  }

  function setBusy(b) {
    S.busy = b;
    els.send.disabled = b; els.input.disabled = b;
    setIcon(els.send, b ? 'loader-2' : 'arrow-up');
    if (b) els.send.querySelector('svg') && els.send.querySelector('svg').classList.add('spin');
  }

  async function runTurn(message, images, screenshot) {
    images = images || [];
    const userTurn = { role: 'user', content: message };
    S.history.push(userTurn);
    setBusy(true); S.raw = ''; S.aiLine = null;
    const ctrl = new AbortController(); S.abort = ctrl;

    let res;
    try {
      res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Majin-Token': (await ensureToken()) || '' },
        body: JSON.stringify({ history: S.history.slice(0, -1), message, images, screenshot: !!screenshot }),
        signal: ctrl.signal
      });
    } catch (e) { return endTurn(e); }
    if (!res.ok || !res.body) {
      let msg = 'Request failed (' + res.status + ')';
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
      return endTurn(new Error(msg));
    }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          if (!line || line[0] === ':' || line.slice(0, 5) !== 'data:') continue;
          const payload = line.slice(5).trim(); if (!payload || payload === '[DONE]') continue;
          let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
          handle(ev);
        }
      }
    } catch (e) { return endTurn(e); }
    endTurn();
  }

  function ensureAiLine() {
    if (S.aiLine) return S.aiLine;
    show(); S.aiLine = addLine('ai', 'Majin', '<span class="typing-dot">…</span>'); return S.aiLine;
  }
  function handle(ev) {
    switch (ev.type) {
      case 'token': { ensureAiLine(); S.raw += ev.text || ''; S.aiLine.querySelector('.vbody').innerHTML = md(S.raw); els.log.scrollTop = els.log.scrollHeight; break; }
      case 'notice': addSys(ev.text || ''); break;
      case 'tool': addSys('▸ ' + ev.name + '  ' + shortArgs(ev.args)); break;
      case 'tool_result': if (ev.ok === false) addSys('   ✗ ' + (ev.error || 'failed')); break;
      case 'confirm':
        // Vision overlay acts autonomously: approve the model's own click/type/etc.
        postJSON('/api/confirm', { id: ev.id, approved: true }).catch(() => {});
        addSys('   ✓ auto-ran ' + ev.name);
        break;
      case 'done':
        if (Array.isArray(ev.turnContents)) S.history = S.history.concat(ev.turnContents);
        break;
      case 'error': ensureAiLine(); S.raw += (S.raw ? '\n\n' : '') + '⚠️ ' + (ev.error || 'error'); S.aiLine.querySelector('.vbody').innerHTML = md(S.raw); break;
    }
  }
  function shortArgs(a) { try { const s = JSON.stringify(a || {}); return s.length > 90 ? s.slice(0, 90) + '…' : s; } catch (e) { return ''; } }

  function endTurn(e) {
    S.abort = null; setBusy(false);
    if (e) { if (e.name !== 'AbortError') { ensureAiLine(); S.raw += (S.raw ? '\n\n' : '') + '⚠️ ' + (e.message || String(e)); S.aiLine.querySelector('.vbody').innerHTML = md(S.raw); } }
  }

  /* ---------- wiring ---------- */
  function toggleLog() {
    if (els.log.hidden) { if (els.log.children.length) { els.log.hidden = false; S.logOpen = true; } else startCapture(); }
    else { els.log.hidden = true; S.logOpen = false; }
    fitWindow();
  }
  function closeWidget() {
    try { stopCapture(); } catch (e) {}
    if (IS_ELECTRON) { try { window.open('majin:close', '_blank', 'width=1,height=1'); } catch (e) {} }
    try { window.close(); } catch (e) {}
  }

  els.share.onclick = () => { S.active ? stopCapture() : startCapture(); };
  els.send.onclick = send;
  els.see.onclick = toggleLog;
  els.close.onclick = closeWidget;
  els.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { if (S.busy && S.abort) { try { S.abort.abort(); } catch (err) {} } els.input.blur(); }
  });
  // When hosted in a Picture-in-Picture / popup window, stop the capture cleanly on close.
  window.addEventListener('pagehide', () => { try { stopCapture(); } catch (e) {} });
  window.addEventListener('resize', fitWindow);

  // A tiny spinner for the busy send icon.
  const sty = document.createElement('style'); sty.textContent = '.spin{animation:vspin 1s linear infinite}@keyframes vspin{to{transform:rotate(360deg)}}';
  document.head.appendChild(sty);

  try { if (window.lucide) lucide.createIcons(); } catch (e) {}
  paintShare();
  fitWindow();
})();

/* Majin — front end (v29). A thin, framework-free client that owns the chat,
   the Workspace block renderer, voice in/out, image attach, the persistent
   event channel, and the SSE client that streams a turn from /api/agent.
   All capability (OS, files, screen, repo scan, web/PDF reader) lives on the
   server; this file only renders what the server streams, drives the richer
   workspace tabs (Project / Reader / Memory / Activity), and asks for approval
   before anything risky runs. No Tailwind, no build step — fully offline. */
(() => {
  'use strict';

  /* ---------- tiny helpers ---------- */
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Only allow benign URL schemes on direct src/href we build ourselves.
  const safeUrl = u => { const s = String(u == null ? '' : u).trim(); return /^(https?:|data:|blob:)/i.test(s) ? s : '#'; };
  const bn = p => { const s = String(p == null ? '' : p).replace(/[\\/]+$/, ''); const m = s.split(/[\\/]/); return m[m.length - 1] || s; };
  const host = u => { try { return new URL(String(u)).hostname; } catch (e) { return String(u == null ? '' : u); } };
  const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const nowMs = () => Date.now();
  function joinPath(root, rel) {
    const r = String(root || '').replace(/[\\/]+$/, '');
    const clean = String(rel || '').replace(/^([\\/])+/, '').split(/[\\/]/).filter(x => x && x !== '.');
    return r + '\\' + clean.join('\\');
  }
  function fmtBytes(n) { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 1 : 0) : Math.round(n)) + ' ' + u[i]; }
  function timeAgo(ts) { const s = Math.max(0, (Date.now() - ts) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }

  const mdHtml = t => {
    let html;
    try { html = marked.parse(String(t == null ? '' : t)); } catch (e) { return esc(t); }
    // The model — or a web page it read via read_url — may emit raw HTML or hostile
    // links. Strip anything dangerous before it touches the DOM.
    try { if (window.DOMPurify) html = DOMPurify.sanitize(html); } catch (e) { return esc(t); }
    try { return mathize(html); } catch (e) { return html; }
  };

  /* ---------- element registry (maps 1:1 to public/index.html) ---------- */
  const els = {
    root: document.documentElement,
    shell: $('shell'),
    // top bar
    railToggle: $('railToggleBtn'), paletteBtn: $('paletteBtn'),
    statusDot: $('statusDot'), statusText: $('statusText'),
    themeBtn: $('themeBtn'), themeIcon: $('themeIcon'),
    autoBtn: $('autoApproveBtn'), autoIcon: $('autoApproveIcon'),
    ttsBtn: $('ttsToggleBtn'), ttsIcon: $('ttsIcon'),
    newWindow: $('newWindowBtn'), settings: $('settingsBtn'),
    // rail
    rail: $('convRail'), newThread: $('newThreadBtn'), convSearch: $('convSearch'),
    threadList: $('threadList'), exportBtn: $('exportBtn'), snippetsBtn: $('snippetsBtn'),
    railSplitter: $('railSplitter'),
    // chat
    msgs: $('chatMessages'), scrollPill: $('scrollPill'), scrollCount: $('scrollCount'),
    ctxTray: $('ctxTray'), form: $('chatForm'), attach: $('attachBtn'), mic: $('micBtn'),
    screen: $('screenBtn'),
    imgInput: $('imgInput'), input: $('chatInput'), suggest: $('suggest'),
    stop: $('stopBtn'), send: $('sendBtn'),
    modelChip: $('modelChip'), modelChipLabel: $('modelChipLabel'),
    cwdChip: $('cwdChip'), cwdChipLabel: $('cwdChipLabel'), busy: $('busyLabel'), modelPop: $('modelPop'),
    wsSplitter: $('wsSplitter'),
    // workspace
    wsTabs: $('wsTabs'), actBadge: $('actBadge'), clearWorkspace: $('clearWorkspaceBtn'),
    stage: $('actionStage'), stageVis: $('actionVis'), stageVerb: $('actionVerb'), stageDetail: $('actionDetail'),
    wsTitle: $('wsTitle'), blocks: $('blocks'), emptyCanvas: $('emptyCanvas'), hintChips: $('hintChips'),
    scanPath: $('scanPath'), scanGo: $('scanGoBtn'), projectBody: $('projectBody'),
    readUrl: $('readUrl'), readGo: $('readGoBtn'), readerBody: $('readerBody'),
    memoryStats: $('memoryStats'), reminderList: $('reminderList'), memoryHits: $('memoryHits'),
    activity: $('activity'), approvalLog: $('approvalLog'),
    // status bar
    sbThread: $('sbThread'), sbMetrics: $('sbMetrics'), sbConn: $('sbConn'),
    // confirm modal
    confirmModal: $('confirmModal'), confirmTool: $('confirmTool'), confirmReason: $('confirmReason'),
    confirmArgs: $('confirmArgs'), approve: $('approveBtn'), deny: $('denyBtn'),
    // settings modal
    settingsModal: $('settingsModal'), settingsClose: $('settingsCloseBtn'),
    providerSelect: $('providerSelect'), modelSelect: $('modelSelect'),
    refreshModelsBtn: $('refreshModelsBtn'), modelsLoading: $('modelsLoading'), motionToggle: $('motionToggle'),
    keyStatus: $('keyStatus'), keyError: $('keyError'),
    geminiMask: $('geminiMask'), groqMask: $('groqMask'), freellmMask: $('freellmMask'),
    apiKeyInput: $('apiKeyInput'), groqKeyInput: $('groqKeyInput'), freellmKeyInput: $('freellmKeyInput'), freellmBaseInput: $('freellmBaseInput'),
    keyVisBtn: $('toggleKeyVisBtn'), groqVisBtn: $('toggleGroqVisBtn'), freellmVisBtn: $('toggleFreellmVisBtn'),
    saveKey: $('saveKeyBtn'), cancelKey: $('cancelKeyBtn'),
    // snippets / palette / lightbox / toast / confetti
    snippetsDrawer: $('snippetsDrawer'), snippetsList: $('snippetsList'), addSnippet: $('addSnippetBtn'), snippetsClose: $('snippetsCloseBtn'),
    palette: $('palette'), paletteInput: $('paletteInput'), paletteList: $('paletteList'),
    lightbox: $('lightbox'), lightboxImg: $('lightboxImg'),
    toastHost: $('toastHost'), confetti: $('confetti')
  };

  /* ---------- app state ---------- */
  const S = {
    history: [], busy: false, attach: null, lastAttachUrl: '', recognising: false,
    tts: localStorage.getItem('majin_tts') === '1',
    autoApprove: localStorage.getItem('majin_auto_approve') === '1',
    themeMode: localStorage.getItem('majin_theme') || 'system',
    motion: (() => { const m = localStorage.getItem('majin_motion'); if (m != null) return m === '1'; return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); })(),
    blocks: 0, stickBottom: true, unread: 0, noKeyWarned: false,
    threads: [], active: null, tab: 'canvas',
    turnStart: 0, turnTools: 0,
    trace: [], traceEl: null, traceDone: false
  };
  const ls = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };

  /* ---------- Vision (floating screen-share pill) ----------
     The bar itself is a self-contained page (public/vision.html + js/vision.js). The
     main app only LAUNCHES it and remembers the floating window so we don't open two.
     In the desktop app that window is transparent + always-on-top; in a browser it is
     a Document Picture-in-Picture window (always-on-top over every app). */
  let VISION_PIP = null;

  /* ---------- CSRF / same-origin session token ----------
     The server boots with a random token (see /api/boot). We fetch it once and echo
     it in the X-Majin-Token header on every state-changing POST. A cross-origin page
     can't read /api/boot and can't add this custom header on a no-cors POST without a
     preflight we never grant, so drive-by requests to /api/agent etc. are rejected. */
  let CSRF = null;
  async function ensureToken() {
    if (CSRF) return CSRF;
    try { const r = await fetch('/api/boot'); CSRF = (await r.json()).token || null; } catch (e) {}
    return CSRF;
  }
  async function postJSON(url, body) {
    const tok = await ensureToken();
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Majin-Token': tok || '' }, body: JSON.stringify(body || {}) });
  }

  /* ---------- math notation (offline, zero-dependency) ----------
     Turns powers, subscripts, fractions, roots, \lim / \sum / \int and a wide set of
     LaTeX commands into real symbols in chat AND workspace text. It runs on the HTML
     marked already produced, touching only text nodes outside <code>/<pre>, so file
     paths, snake_case identifiers and code samples are never mangled. */
  const TEX = {
    infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
    pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', lt: '<', gt: '>', approx: '≈', cong: '≅',
    equiv: '≡', sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫',
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
    cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
    forall: '∀', exists: '∃', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
    oplus: '⊕', otimes: '⊗', perp: '⊥', parallel: '∥',
    to: '→', rightarrow: '→', Rightarrow: '⇒', longrightarrow: '⟶', leftarrow: '←', Leftarrow: '⇐', longleftarrow: '⟵',
    leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
    nearrow: '↗', searrow: '↘', swarrow: '↙', nwarrow: '↖',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
    rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    angle: '∠', triangle: '△', square: '□', degree: '°', prime: '′', surd: '√', sqrt: '√',
    therefore: '∴', because: '∵', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
    langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
    hbar: 'ℏ', ell: 'ℓ', aleph: 'ℵ', Re: 'ℜ', Im: 'ℑ', wp: '℘',
    sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
    sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', max: 'max', min: 'min',
    det: 'det', dim: 'dim', deg: 'deg', gcd: 'gcd', lim: 'lim', limsup: 'limsup', liminf: 'liminf', mod: 'mod'
  };
  function notationToHTML(s) {
    let out = esc(s);
    out = out.replace(/\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle|limits|nolimits)\b\s*/g, '');
    out = out.replace(/\\(?:left|right|middle|bigg?[lrm]?|Bigg?[lrm]?)\b\s*/g, '');
    out = out.replace(/\\[()[\]]/g, '');
    out = out.replace(/\\([{}])/g, '$1');
    out = out.replace(/\$\$([\s\S]*?)\$\$/g, '$1').replace(/(?<![\d.])\$([^$\n]+?)\$(?![\d.])/g, '$1');
    const FRAC = /\\frac\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
    for (let i = 0; i < 4 && out.indexOf('\\frac') !== -1; i++) {
      const next = out.replace(FRAC, (m, a, b) =>
        '<span class="frac"><span class="fn">' + a + '</span><span class="fd">' + b + '</span></span>');
      if (next === out) break; out = next;
    }
    out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, (m, a) => '\u221A<span class="sqr">' + a + '</span>');
    out = out.replace(/\\[,;:! ]/g, ' ');
    out = out.replace(/\\([A-Za-z]+)/g, (m, w) => (TEX[w] != null ? TEX[w] : m));
    out = out.replace(/\^\s*\{([^{}]*)\}/g, (m, a) => '<sup>' + a + '</sup>')
      .replace(/\^(-?\d+)/g, (m, a) => '<sup>' + a + '</sup>')
      .replace(/\^([A-Za-z])/g, (m, a) => '<sup>' + a + '</sup>');
    out = out.replace(/_\s*\{([^{}]*)\}/g, (m, a) => '<sub>' + a + '</sub>')
      .replace(/_(\d+)/g, (m, a) => '<sub>' + a + '</sub>');
    out = out.replace(/-&gt;/g, '\u2192').replace(/=&gt;/g, '\u21D2').replace(/&lt;-/g, '\u2190')
      .replace(/&lt;=/g, '\u2264').replace(/&gt;=/g, '\u2265').replace(/!=/g, '\u2260');
    return out;
  }
  const MATH_TRIGGER = /[\\^_]|\->|=>|<-|<=|>=|!=|\$\$?/;
  function mathize(html) {
    if (!MATH_TRIGGER.test(html)) return html;                 // nothing to upgrade — skip the DOM walk
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !MATH_TRIGGER.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        let p = node.parentNode;
        while (p) { const t = p.nodeName; if (t === 'CODE' || t === 'PRE' || t === 'SCRIPT' || t === 'STYLE') return NodeFilter.FILTER_REJECT; p = p.parentNode; }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const targets = []; while (walker.nextNode()) targets.push(walker.currentNode);
    for (const node of targets) {
      const out = notationToHTML(node.nodeValue);
      if (out === esc(node.nodeValue)) continue;               // no change
      const holder = document.createElement('span'); holder.innerHTML = out;
      node.replaceWith(...holder.childNodes);
    }
    return tpl.innerHTML;
  }

  /* ---------- theme + reduced motion ---------- */
  const mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function resolveTheme() {
    if (S.themeMode === 'system') return (mqDark && mqDark.matches) ? 'dark' : 'light';
    return S.themeMode;
  }
  function applyTheme() {
    const t = resolveTheme();
    els.root.setAttribute('data-theme', t);
    // lucide swaps the <i> for an <svg>, so repaint through the (always-live) button, not the stale <i> node.
    paintBtnIcon(els.themeBtn, S.themeMode === 'system' ? 'monitor' : (t === 'dark' ? 'moon' : 'sun'));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#070b14' : '#eef2f8');
  }
  function cycleTheme() {
    S.themeMode = S.themeMode === 'system' ? 'light' : S.themeMode === 'light' ? 'dark' : 'system';
    ls('majin_theme', S.themeMode); applyTheme();
    toast('Theme', S.themeMode === 'system' ? 'Following your system' : S.themeMode[0].toUpperCase() + S.themeMode.slice(1) + ' mode');
  }
  if (mqDark && mqDark.addEventListener) mqDark.addEventListener('change', () => { if (S.themeMode === 'system') applyTheme(); });
  function applyMotion() {
    const prefers = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const noMotion = !S.motion || prefers;
    els.root.classList.toggle('no-motion', noMotion);
    if (els.motionToggle) els.motionToggle.checked = !noMotion;
    return noMotion;
  }

  /* ---------- status ---------- */
  function providerLabel(p) { return p === 'groq' ? 'Groq' : p === 'freellm' ? 'FreeLLM' : 'Gemini'; }
  async function checkStatus() {
    try {
      const r = await fetch('/api/status'); const j = await r.json();
      const ok = !!j.hasKey;
      S.supportsVision = !!j.vision;
      els.statusDot.className = 'status-dot ' + (ok ? 'ok' : 'off');
      els.statusText.textContent = ok ? (providerLabel(j.provider) + ' · ' + j.model) : 'no API key';
      if (els.modelChipLabel) els.modelChipLabel.textContent = ok ? j.model : 'model';
      if (!ok) { if (!S.noKeyWarned) { S.noKeyWarned = true; addMsg('model', "⚠️ No API key yet. Click **Settings** and paste your Gemini (or Groq) API key — Majin saves it to `.env` for you, no restart needed."); } }
      else S.noKeyWarned = false;
    } catch (e) { els.statusDot.className = 'status-dot off'; els.statusText.textContent = 'server offline'; if (els.modelChipLabel) els.modelChipLabel.textContent = 'offline'; }
  }

  /* ---------- chat rendering ---------- */
  function msgActions(kind) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const mk = (act, icon, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ma ma-' + act; b.dataset.act = act; b.title = title;
      b.innerHTML = '<i data-lucide="' + icon + '"></i>';
      return b;
    };
    bar.appendChild(mk('copy', 'copy', 'Copy'));
    if (kind === 'model') bar.appendChild(mk('regen', 'refresh-cw', 'Regenerate'));
    if (kind === 'user') bar.appendChild(mk('edit', 'pencil', 'Edit & resend'));
    return bar;
  }
  function addMsg(role, text, images) {
    const isUser = role === 'user';
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (isUser ? 'user' : 'model');
    const av = document.createElement('div');
    av.className = 'avatar ' + (isUser ? 'av-user' : 'av-model');
    av.innerHTML = '<i data-lucide="' + (isUser ? 'user' : 'sparkles') + '"></i>';
    const body = document.createElement('div');
    body.className = 'msg-col';
    const bubble = document.createElement('div');
    bubble.className = 'bubble fade-up';
    bubble.dataset.raw = String(text == null ? '' : text);
    if (isUser) bubble.textContent = text; else bubble.innerHTML = mdHtml(text);
    body.appendChild(bubble);
    if (isUser && images && images.length) {
      const gal = document.createElement('div');
      gal.className = 'msg-imgs';
      for (const im of images) {
        if (!im) continue;
        const src = im.preview || ('data:' + (im.mime || 'image/png') + ';base64,' + (im.data || ''));
        const img = document.createElement('img');
        img.src = safeUrl(src); img.alt = 'shared screen'; img.loading = 'lazy';
        img.onclick = () => openLight(img.src);
        gal.appendChild(img);
      }
      if (gal.children.length) body.appendChild(gal);
    }
    body.appendChild(msgActions(isUser ? 'user' : 'model'));
    wrap.appendChild(av); wrap.appendChild(body);
    els.msgs.appendChild(wrap);
    if (isUser) scrollToBottom(true); else scrollToBottom(false);
    refreshActions();
    lucide.createIcons();
    if (!isUser) body.querySelectorAll('pre code').forEach(el => { try { hljs.highlightElement(el); } catch (e) {} });
    return bubble;
  }

  /* ---------- smart scroll + jump-to-latest ---------- */
  function isNearBottom() { return els.msgs.scrollHeight - els.msgs.scrollTop - els.msgs.clientHeight < 130; }
  function scrollToBottom(force) {
    if (force) { S.stickBottom = true; S.unread = 0; els.msgs.scrollTop = els.msgs.scrollHeight; updateScrollPill(); return; }
    if (S.stickBottom) els.msgs.scrollTop = els.msgs.scrollHeight;
    updateScrollPill();
  }
  function updateScrollPill() {
    if (!els.scrollPill) return;
    els.scrollPill.hidden = S.stickBottom;
    if (S.unread > 0) { els.scrollCount.textContent = S.unread > 99 ? '99+' : S.unread; els.scrollCount.hidden = false; }
    else els.scrollCount.hidden = true;
  }
  function goLatest() { S.stickBottom = true; S.unread = 0; els.msgs.scrollTop = els.msgs.scrollHeight; updateScrollPill(); els.input.focus(); }
  els.msgs.addEventListener('scroll', () => { S.stickBottom = isNearBottom(); if (S.stickBottom) S.unread = 0; updateScrollPill(); });
  if (els.scrollPill) els.scrollPill.onclick = goLatest;

  /* ---------- live bubble + animated thinking indicator ---------- */
  let liveBubble = null, thinkTimer = null, thinkStart = 0;
  function thinkingHtml(label) {
    return '<span class="typing"><i></i><i></i><i></i></span><span class="thinking-txt">' + esc(label || 'Majin is thinking') + '</span><span class="elapsed">0s</span>';
  }
  function startThinking(label) {
    if (!liveBubble) return;
    thinkStart = Date.now();
    liveBubble.dataset.raw = '';
    liveBubble.dataset.thinking = '1';
    liveBubble.innerHTML = thinkingHtml(label);
    if (thinkTimer) clearInterval(thinkTimer);
    thinkTimer = setInterval(() => { const e = liveBubble && liveBubble.querySelector('.elapsed'); if (e) e.textContent = Math.floor((Date.now() - thinkStart) / 1000) + 's'; }, 500);
  }
  function stopThinking() { if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; } }
  function ensureLive() {
    if (liveBubble) return liveBubble;
    liveBubble = addMsg('model', '');
    startThinking();
    return liveBubble;
  }
  function appendLive(text) {
    ensureLive();
    if (liveBubble.dataset.thinking) { liveBubble.dataset.thinking = ''; stopThinking(); liveBubble.innerHTML = ''; }
    liveBubble.dataset.raw = (liveBubble.dataset.raw || '') + text;
    liveBubble.innerHTML = mdHtml(liveBubble.dataset.raw);
    if (S.stickBottom) els.msgs.scrollTop = els.msgs.scrollHeight; else { S.unread++; updateScrollPill(); }
  }
  function bubbleHasContent(b) {
    if (!b) return false;
    if (b.querySelector('img, canvas, pre, table, .frac, .m-val, .typing, .hero-t, .chip, .p-row')) return true;
    return (b.textContent || '').trim().length > 0;
  }
  function finishLive(finalText) {
    stopThinking();
    const b = liveBubble; liveBubble = null;
    if (!b) return;
    const raw = (finalText != null ? String(finalText) : (b.dataset.raw || ''));
    b.dataset.thinking = '';
    if (raw.trim() === '') { const w = b.closest('.msg.model'); if (w) w.remove(); refreshActions(); return; }
    b.dataset.raw = raw; b.innerHTML = mdHtml(raw);
    b.querySelectorAll('pre code').forEach(el => { try { hljs.highlightElement(el); } catch (e) {} });
    refreshActions();
  }

  /* ---------- message actions: copy / regenerate / edit-resend ---------- */
  els.msgs.addEventListener('click', e => {
    const btn = e.target.closest('.ma'); if (!btn) return;
    const col = btn.closest('.msg-col'); const bubble = col && col.querySelector('.bubble');
    const act = btn.dataset.act;
    if (act === 'copy') copyText(bubble ? bubble.dataset.raw : '', btn);
    else if (act === 'regen') regenerate();
    else if (act === 'edit') editLastUser(bubble);
  });
  function copyText(text, btn) {
    const flash = () => { paintBtnIcon(btn, 'check'); setTimeout(() => paintBtnIcon(btn, 'copy'), 1200); };
    const fallback = () => { try { const ta = document.createElement('textarea'); ta.value = text || ''; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch (e) {} };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text || '').then(flash, () => { fallback(); flash(); });
    else { fallback(); flash(); }
  }
  function refreshActions() {
    if (!els.msgs) return;
    els.msgs.querySelectorAll('.ma-regen,.ma-edit').forEach(b => b.classList.remove('eligible'));
    const models = els.msgs.querySelectorAll('.msg.model'), users = els.msgs.querySelectorAll('.msg.user');
    const lm = models[models.length - 1]; if (lm) { const b = lm.querySelector('.ma-regen'); if (b) b.classList.add('eligible'); }
    const lu = users[users.length - 1]; if (lu) { const b = lu.querySelector('.ma-edit'); if (b) b.classList.add('eligible'); }
  }
  function lastUserTurnIndex() { for (let i = S.history.length - 1; i >= 0; i--) { const m = S.history[i]; if (m && m.role === 'user' && m.content && !m.tool_results) return i; } return -1; }
  function removeRenderedFromLastUser() {
    const kids = [...els.msgs.children]; let lu = -1;
    kids.forEach((w, i) => { if (w.classList.contains('user')) lu = i; });
    if (lu < 0) return;
    for (let i = kids.length - 1; i >= lu; i--) els.msgs.removeChild(els.msgs.children[i]);
  }
  function regenerate() {
    if (S.busy) return;
    const idx = lastUserTurnIndex(); if (idx < 0) return;
    const msg = String(S.history[idx].content || ''); if (!msg) return;
    S.history = S.history.slice(0, idx);
    removeRenderedFromLastUser();
    addMsg('user', msg);
    runTurn(msg, []);
  }
  function editLastUser(bubble) {
    if (S.busy || !bubble) return;
    const idx = lastUserTurnIndex(); if (idx < 0) return;
    const orig = String(S.history[idx].content || '');
    const wrap = bubble.closest('.msg.user');
    const ta = document.createElement('textarea'); ta.className = 'edit-ta'; ta.value = orig;
    const bar = document.createElement('div'); bar.className = 'edit-bar';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'ea ea-save'; save.textContent = 'Save & resend';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ea ea-cancel'; cancel.textContent = 'Cancel';
    bar.appendChild(save); bar.appendChild(cancel);
    bubble.classList.add('editing'); bubble.innerHTML = ''; bubble.appendChild(ta); bubble.appendChild(bar);
    ta.focus();
    const restore = () => { bubble.classList.remove('editing'); bubble.textContent = orig; refreshActions(); };
    cancel.onclick = restore;
    ta.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); restore(); } if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); save.click(); } });
    save.onclick = () => {
      const nt = ta.value.trim(); if (!nt) return;
      S.history = S.history.slice(0, idx);
      let el = wrap;
      while (el) { const nx = el.nextElementSibling; els.msgs.removeChild(el); el = nx; }
      addMsg('user', nt);
      runTurn(nt, []);
    };
  }

  /* ---------- workspace blocks ---------- */
  const ICONS = { info: 'info', success: 'check-circle-2', warn: 'alert-triangle', danger: 'shield-alert' };
  const TONES = { info: 'info', success: 'success', warn: 'warn', warning: 'warn', danger: 'danger', error: 'danger' };
  const toneCls = t => 'tone-' + (TONES[t] || 'info');
  function hideCanvasEmpty() { if (els.emptyCanvas) els.emptyCanvas.hidden = true; }
  function renderWorkspace({ title, blocks }) {
    hideCanvasEmpty();
    setTab('canvas', true);                       // structured output always belongs on the Canvas
    if (title) { els.wsTitle.textContent = title; els.wsTitle.hidden = false; }
    const made = [];
    for (const b of blocks || []) { const el = renderBlock(b); els.blocks.appendChild(el); made.push(el); }
    S.blocks += (blocks || []).length;
    lucide.createIcons();
    requestAnimationFrame(() => made.forEach(animateBlock));
  }
  function animateBlock(el) {
    el.querySelectorAll('.m-val[data-to]').forEach(node => {
      const target = parseFloat(node.dataset.to);
      if (!isFinite(target)) return;
      const dec = (String(node.dataset.to).split('.')[1] || '').length;
      const dur = 900, t0 = performance.now();
      const step = now => {
        const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        node.textContent = (target * e).toFixed(dec);
        if (p < 1) requestAnimationFrame(step); else node.textContent = target.toFixed(dec);
      };
      requestAnimationFrame(step);
    });
    el.querySelectorAll('.p-fill[data-w]').forEach(f => { f.style.width = clamp(parseFloat(f.dataset.w) || 0, 0, 100) + '%'; });
  }
  function cardShell(title, inner) {
    return `<div class="card">${title ? `<div class="card-t">${mdHtml(title)}</div>` : ''}${inner}</div>`;
  }
  function renderBlock(b) {
    const el = document.createElement('div');
    el.className = 'block fade-up';
    const t = b.type;
    if (t === 'heading') {
      el.classList.add('b-heading');
      const lvl = String(b.title || '').length > 46 ? 'h3' : 'h2';
      el.innerHTML = `<${lvl}>${mdHtml(b.title)}</${lvl}>`;
    } else if (t === 'text') {
      el.classList.add('b-text'); el.innerHTML = mdHtml(b.body || b.title || '');
    } else if (t === 'list') {
      el.innerHTML = cardShell(b.title, '<ul class="b-list">' + (b.items || []).map(i => `<li><span>${mdHtml(i)}</span></li>`).join('') + '</ul>');
    } else if (t === 'steps') {
      el.innerHTML = cardShell(b.title, '<ol class="b-steps">' + (b.items || []).map(i => `<li><span class="n"></span><span>${mdHtml(i)}</span></li>`).join('') + '</ol>');
    } else if (t === 'checklist') {
      el.innerHTML = cardShell(b.title, '<ul class="b-check">' + (b.items || []).map(i => `<li><span class="box"></span><span>${mdHtml(i)}</span></li>`).join('') + '</ul>');
      el.querySelectorAll('.b-check li').forEach(li => li.onclick = () => li.classList.toggle('done'));
    } else if (t === 'keyvalue') {
      el.innerHTML = cardShell(b.title, '<div class="b-kv">' + (b.pairs || []).map(p => `<div class="k">${esc(p.key)}</div><div class="v">${mdHtml(p.value)}</div>`).join('') + '</div>');
    } else if (t === 'table') {
      const tb = b.table || {};
      el.innerHTML = cardShell(b.title, '<table class="b-table"><thead><tr>' + (tb.headers || []).map(h => `<th>${mdHtml(h)}</th>`).join('') + '</tr></thead><tbody>' +
        (tb.rows || []).map(r => '<tr>' + (r || []).map(c => `<td>${mdHtml(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
    } else if (t === 'callout') {
      const tone = TONES[b.tone] || 'info';
      el.classList.add('b-callout', 'callout-' + tone);
      el.innerHTML = `<i data-lucide="${ICONS[tone] || 'info'}" class="ci"></i><div>${mdHtml(b.body || b.title || '')}</div>`;
    } else if (t === 'code') {
      el.classList.add('b-code');
      el.innerHTML = (b.body_lang ? `<div class="lang">${esc(b.body_lang)}</div>` : '') + `<pre><code class="language-${esc((b.body_lang || 'plaintext').toLowerCase())}">${esc(b.body || '')}</code></pre>`;
      el.querySelectorAll('pre code').forEach(c => { try { hljs.highlightElement(c); } catch (e) {} });
    } else if (t === 'image') {
      el.classList.add('b-image'); el.innerHTML = `<img src="${safeUrl(b.url)}" alt="${esc(b.title || '')}" loading="lazy">` + (b.title ? `<div class="cap">${mdHtml(b.title)}</div>` : '');
      const im = el.querySelector('img'); if (im) im.onclick = () => openLight(im.src);
    } else if (t === 'hero') {
      el.classList.add('b-hero', toneCls(b.tone));
      el.innerHTML = `<div class="hero-glow"></div><div class="hero-t">${mdHtml(b.title || b.body || '')}</div>` + (b.title && b.body ? `<div class="hero-s">${mdHtml(b.body)}</div>` : '');
    } else if (t === 'metrics') {
      el.classList.add('b-metrics');
      el.innerHTML = (b.stats || []).map((s, i) => {
        const raw = String(s.value == null ? '' : s.value);
        const numeric = /^-?\d+(?:\.\d+)?$/.test(raw);
        const unit = s.unit ? `<span class="m-unit">${esc(s.unit)}</span>` : '';
        return `<div class="m-card ${toneCls(s.tone)}" style="--i:${i}"><div class="m-figure">${numeric ? `<div class="m-val" data-to="${raw}">0</div>` : `<div class="m-val">${esc(raw)}</div>`}${unit}</div><div class="m-label">${esc(s.label || '')}</div></div>`;
      }).join('');
    } else if (t === 'progress') {
      el.innerHTML = cardShell(b.title, '<div class="b-progress">' + (b.bars || []).map((bar, i) => {
        const v = parseFloat(bar.value), mx = parseFloat(bar.max == null ? '' : bar.max);
        const pct = (isFinite(v) && isFinite(mx) && mx > 0) ? clamp(v / mx * 100, 2, 100) : (isFinite(v) ? clamp(v, 0, 100) : 0);
        const shown = (bar.max != null ? `${esc(bar.value)}${esc(bar.unit || '')} / ${esc(bar.max)}${esc(bar.unit || '')}` : `${esc(bar.value)}${esc(bar.unit || '')}`);
        return `<div class="p-row ${toneCls(bar.tone)}" style="--i:${i}"><div class="p-top"><span class="p-lab">${esc(bar.label || '')}</span><span class="p-num">${shown}</span></div><div class="p-track"><div class="p-fill" data-w="${pct.toFixed(1)}"></div></div></div>`;
      }).join('') + '</div>');
    } else if (t === 'timeline') {
      el.innerHTML = cardShell(b.title, '<div class="b-timeline">' + (b.items || []).map((it, i) => `<div class="tl-item" style="--i:${i}"><span class="tl-dot"></span><div class="tl-txt">${mdHtml(it)}</div></div>`).join('') + '</div>');
    } else if (t === 'chips') {
      el.classList.add('b-chips');
      el.innerHTML = (b.items || []).map((c, i) => `<span class="chip" style="--i:${i}">${esc(c)}</span>`).join('');
    } else if (t === 'quote') {
      el.classList.add('b-quote');
      el.innerHTML = `<i data-lucide="quote" class="q-i"></i><div class="q-txt">${mdHtml(b.body || b.title || '')}</div>`;
    } else if (t === 'divider') {
      el.classList.add('b-divider');
    } else if (t === 'gauge') {
      el.classList.add('b-gauge', toneCls(b.tone));
      const v = parseFloat(b.value), mx = parseFloat(b.max == null || b.max === '' ? '100' : b.max);
      const vOk = isFinite(v), mxOk = isFinite(mx) && mx > 0;
      const pct = vOk ? clamp(mxOk ? v / mx * 100 : v, 0, 100) : 0;
      const dispVal = String(b.value == null ? '' : b.value);
      const final = (vOk && mxOk) ? (Math.round(pct) + '%') : esc(dispVal || Math.round(pct) + '%');
      const unit = b.unit ? `<div class="g-unit">${esc(b.unit)}</div>` : '';
      const label = (b.label || b.title) ? `<div class="g-lab">${mdHtml(b.label || b.title)}</div>` : '';
      el.innerHTML = `<div class="g-wrap" style="--dash-to:${(100 - pct).toFixed(2)}">` +
        `<svg viewBox="0 0 100 100" class="g-svg"><circle class="g-track" cx="50" cy="50" r="40"/><circle class="g-fill" cx="50" cy="50" r="40" pathLength="100"/></svg>` +
        `<div class="g-center"><div class="g-val">${final}</div>${unit}</div></div>${label}`;
    } else if (t === 'spark') {
      const nums = (Array.isArray(b.series) ? b.series : []).map(x => parseFloat(x)).filter(n => isFinite(n));
      if (nums.length >= 2) {
        const W = 100, H = 34, P = 3;
        const mn = Math.min(...nums), mx2 = Math.max(...nums), rng = (mx2 - mn) || 1;
        const stepx = (W - 2 * P) / (nums.length - 1);
        const pts = nums.map((n, i) => [P + i * stepx, H - P - ((n - mn) / rng) * (H - 2 * P)]);
        const line = pts.map(q => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');
        const area = `M${line.replace(/ /g, 'L')} L${(W - P).toFixed(1)},${H - P} L${P},${H - P} Z`;
        const last = pts[pts.length - 1];
        el.classList.add('b-spark');
        el.innerHTML = (b.title ? `<div class="sp-t">${mdHtml(b.title)}</div>` : '') +
          `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="sp-svg">` +
          `<defs><linearGradient id="spg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(34,211,238,.32)"/><stop offset="1" stop-color="rgba(34,211,238,0)"/></linearGradient></defs>` +
          `<path class="sp-area" d="${area}" fill="url(#spg)"/>` +
          `<polyline class="sp-line" points="${line}" pathLength="100"/>` +
          `<circle class="sp-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2"/>` +
          `</svg>`;
      } else { el.classList.add('b-text'); el.innerHTML = mdHtml((b.items || []).join(' ') || b.title || ''); }
    } else {
      el.classList.add('b-text'); el.innerHTML = mdHtml(b.body || b.title || JSON.stringify(b));
    }
    return el;
  }
  /* runtime state that later sections and the SSE loop share */
  S.actQueue = {}; S.actCount = 0; S.stageTimer = null; S.pendingConfirm = null;
  S.memc = (() => { try { return Object.assign({ index: 0, search: 0, stats: 0, forget: 0 }, JSON.parse(lsGet('majin_memc') || '{}')); } catch (e) { return { index: 0, search: 0, stats: 0, forget: 0 }; } })();
  S.PROJ = { root: '', modules: [], edges: [], scanPath: '' };
  S.readerUrl = '';

  /* ---------- adaptive action HUD (one animated scene per capability) ---------- */
  function svWrap(inner, wide) { return '<svg class="sv' + (wide ? ' wide' : '') + '" viewBox="0 0 48 48" aria-hidden="true">' + inner + '</svg>'; }
  const SCENE_SVG = {
    'vis-scan': '<path class="fr" d="M10 16v-6h6M32 10h6v6M38 32v6h-6M16 38h-6v-6"/><rect class="ret" x="18" y="18" width="12" height="12" rx="2"/><line class="sbar" x1="12" y1="13" x2="36" y2="13"/>',
    'vis-mag': '<g class="rows"><line x1="10" y1="15" x2="30" y2="15"/><line x1="10" y1="23" x2="26" y2="23"/><line x1="10" y1="31" x2="22" y2="31"/></g><circle class="mg" cx="31" cy="31" r="9"/><line class="mh" x1="38" y1="38" x2="44" y2="44"/>',
    'vis-doc': '<path class="pg" d="M14 8h13l9 9v23a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z"/><g class="lines"><line x1="18" y1="22" x2="32" y2="22"/><line x1="18" y1="28" x2="32" y2="28"/><line x1="18" y1="34" x2="28" y2="34"/></g>',
    'vis-docw': '<path class="pg" d="M14 8h13l9 9v23a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z"/><line class="wl" x1="18" y1="24" x2="32" y2="24"/><line class="wl" x1="18" y1="30" x2="32" y2="30"/><line class="ink" x1="18" y1="36" x2="32" y2="36"/>',
    'vis-folder': '<path class="fb" d="M8 18a2 2 0 0 1 2-2h8l3 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z"/><path class="flap" d="M8 21h32"/><line class="fitem f1" x1="14" y1="27" x2="30" y2="27"/><line class="fitem f2" x1="14" y1="32" x2="26" y2="32"/>',
    'vis-move': '<rect class="ed" x="6" y="18" width="13" height="12" rx="2"/><rect class="lnk" x="29" y="18" width="13" height="12" rx="2"/><line class="ed" x1="20" y1="24" x2="37" y2="24"/><path class="arrh" d="M42 24l-4-2.4v4.8z"/><circle class="car" cx="22" cy="24" r="2.4"/>',
    'vis-mkdir': '<path class="fb" d="M8 18a2 2 0 0 1 2-2h8l3 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z"/><path class="flap" d="M8 21h32"/><rect class="grow" x="20" y="26" width="14" height="10" rx="2"/><path class="plus" d="M27 28.5v5M24.5 31h5"/>',
    'vis-del': '<path class="bx" d="M14 16h20l-2 22a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2z"/><path class="card" d="M20 7h8v9h-8z"/>',
    'vis-install': '<circle class="ring" cx="24" cy="24" r="16" pathLength="100"/><path class="ar" d="M24 15v11M18 22l6 6 6-6"/><line class="tray" x1="13" y1="39" x2="35" y2="39"/>',
    'vis-term': '<rect class="fr" x="6" y="10" width="36" height="28" rx="3"/><line class="tb" x1="6" y1="17" x2="42" y2="17"/><path class="pp" d="M12 25l4 3-4 3"/><line class="cl" x1="20" y1="28" x2="33" y2="28"/><line class="cr" x1="36" y1="24" x2="36" y2="32"/>',
    'vis-clip': '<rect class="brd" x="12" y="11" width="24" height="29" rx="3"/><rect class="ct2" x="19" y="8" width="10" height="6" rx="2"/><rect class="sheet" x="17" y="18" width="14" height="15" rx="2"/>',
    'vis-win': '<rect class="w3" x="8" y="12" width="26" height="17" rx="2"/><rect class="w2" x="13" y="17" width="26" height="17" rx="2"/><rect class="w1" x="18" y="22" width="24" height="16" rx="2"/><line class="wtb" x1="18" y1="27" x2="42" y2="27"/>',
    'vis-power': '<path class="pg2" d="M24 8v15"/><path class="pv" d="M16 13a11 11 0 1 0 16 0"/><circle class="pr" cx="24" cy="24" r="20"/>',
    'vis-bell': '<path class="bl" d="M24 12a7 7 0 0 1 7 7v6l3 4H14l3-4v-6a7 7 0 0 1 7-7z"/><path class="ct" d="M21 33a3 3 0 0 0 6 0"/><circle class="rip" cx="24" cy="9" r="3"/>',
    'vis-notify': '<rect class="nt" x="8" y="16" width="32" height="16" rx="3"/><circle class="nd" cx="15" cy="24" r="2.4"/><line class="nl" x1="21" y1="22" x2="35" y2="22"/><line class="nl" x1="21" y1="27" x2="31" y2="27"/>',
    'vis-cpu': '<rect class="ch" x="15" y="15" width="18" height="18" rx="3"/><rect class="orb" x="9" y="9" width="30" height="30" rx="7"/><circle class="od" cx="24" cy="5" r="2.6"/>',
    'vis-radar': '<circle class="rr" cx="24" cy="24" r="16"/><circle class="rr" cx="24" cy="24" r="9"/><line class="sw" x1="24" y1="24" x2="24" y2="9"/>',
    'vis-globe': '<circle class="g" cx="24" cy="24" r="16"/><ellipse class="mer" cx="24" cy="24" rx="7" ry="16"/><line class="g" x1="8" y1="24" x2="40" y2="24"/>',
    'vis-pulse': '<circle class="halo" cx="24" cy="24" r="9"/><circle class="pul" cx="24" cy="24" r="4"/>'
  };
  function sceneHtml(cls) {
    if (cls === 'vis-bars' || cls === 'vis-kill') return '<div class="bars"><i style="--w:64%"></i><i style="--w:82%"></i><i style="--w:50%"></i><i style="--w:74%"></i></div>';
    if (cls === 'vis-gauge') return '<div class="gauges"><i style="--h:58%"></i><i style="--h:80%"></i><i style="--h:44%"></i></div>';
    if (cls === 'vis-eq') return '<div class="eq"><i></i><i></i><i></i><i></i><i></i></div>';
    if (cls === 'vis-tiles') return '<div class="tiles">' + '<i></i>'.repeat(6) + '</div>';
    const inner = SCENE_SVG[cls];
    const wide = cls === 'vis-term' || cls === 'vis-move' || cls === 'vis-notify';
    return svWrap(inner || SCENE_SVG['vis-pulse'], wide);
  }
  const ACT_META = {
    scan_repo: { cls: 'vis-scan', tone: 'info', verb: 'Mapping your project', pick: a => a.path },
    search_files: { cls: 'vis-mag', tone: 'info', verb: 'Searching files', pick: a => a.query },
    web_search: { cls: 'vis-mag', tone: 'info', verb: 'Searching the web', pick: a => a.query },
    memory_search: { cls: 'vis-mag', tone: 'info', verb: 'Searching your memory', pick: a => a.query },
    read_file: { cls: 'vis-doc', tone: 'info', verb: 'Reading file', pick: a => bn(a.path) },
    read_url: { cls: 'vis-doc', tone: 'info', verb: 'Reading the page', pick: a => host(a.url) },
    write_file: { cls: 'vis-docw', tone: 'write', verb: 'Writing file', pick: a => bn(a.path) },
    list_directory: { cls: 'vis-folder', tone: 'info', verb: 'Listing folder', pick: a => bn(a.path) },
    install: { cls: 'vis-install', tone: 'danger', verb: 'Installing software', pick: a => a.target },
    run_command: { cls: 'vis-term', tone: 'danger', verb: 'Running a command', pick: a => cut(a.command, 46) },
    kill_process: { cls: 'vis-kill', tone: 'danger', verb: 'Stopping a process', pick: a => a.name || ('pid ' + a.pid) },
    list_windows: { cls: 'vis-win', tone: 'info', verb: 'Listing windows' },
    activate_window: { cls: 'vis-win', tone: 'write', verb: 'Focusing a window', pick: a => a.title || ('pid ' + a.pid) },
    open_app: { cls: 'vis-win', tone: 'danger', verb: 'Opening an app', pick: a => a.app },
    power: { cls: 'vis-power', tone: 'danger', verb: 'Power control', pick: a => a.action },
    set_reminder: { cls: 'vis-bell', tone: 'write', verb: 'Setting a reminder', pick: a => cut(a.text, 40) },
    list_reminders: { cls: 'vis-bell', tone: 'info', verb: 'Checking reminders' },
    notify: { cls: 'vis-notify', tone: 'write', verb: 'Sending a notification', pick: a => a.title },
    system_info: { cls: 'vis-cpu', tone: 'info', verb: 'Reading system info' },
    list_processes: { cls: 'vis-cpu', tone: 'info', verb: 'Listing processes' },
    disk_usage: { cls: 'vis-gauge', tone: 'info', verb: 'Checking disk space' },
    screen_info: { cls: 'vis-radar', tone: 'info', verb: 'Reading screen layout' },
    ocr_screen: { cls: 'vis-radar', tone: 'info', verb: 'Reading on-screen text' },
    screenshot: { cls: 'vis-radar', tone: 'info', verb: 'Taking a screenshot' },
    open_url: { cls: 'vis-globe', tone: 'info', verb: 'Opening a link', pick: a => host(a.url) },
    media_key: { cls: 'vis-eq', tone: 'info', verb: 'Media control', pick: a => a.key },
    index_files: { cls: 'vis-scan', tone: 'danger', verb: 'Indexing your files', pick: a => a.path },
    memory_stats: { cls: 'vis-cpu', tone: 'info', verb: 'Checking memory' },
    memory_forget: { cls: 'vis-del', tone: 'danger', verb: 'Forgetting memory', pick: a => a.path || 'the whole index' },
    show_blocks: { cls: 'vis-tiles', tone: 'write', verb: 'Composing the workspace' },
    click: { cls: 'vis-pulse', tone: 'danger', verb: 'Clicking', pick: a => '(' + a.x + ', ' + a.y + ')' },
    move_mouse: { cls: 'vis-pulse', tone: 'danger', verb: 'Moving cursor', pick: a => '(' + a.x + ', ' + a.y + ')' },
    drag: { cls: 'vis-move', tone: 'danger', verb: 'Dragging', pick: a => a.from_x + ',' + a.from_y + ' → ' + a.to_x + ',' + a.to_y },
    scroll: { cls: 'vis-pulse', tone: 'danger', verb: 'Scrolling', pick: a => (a.direction || 'down') + ' × ' + (a.amount || 3) },
    type_text: { cls: 'vis-docw', tone: 'danger', verb: 'Typing', pick: a => cut(a.text, 40) },
    press_keys: { cls: 'vis-term', tone: 'danger', verb: 'Pressing keys', pick: a => a.combo }
  };
  function actFor(name, args) {
    args = args || {};
    if (name === 'manage_files') {
      const op = String(args.op || '').toLowerCase();
      if (op === 'delete') return { cls: 'vis-del', tone: 'danger', verb: 'Deleting', detail: bn(args.src) };
      if (op === 'mkdir') return { cls: 'vis-mkdir', tone: 'write', verb: 'Creating folder', detail: bn(args.dest || args.src) };
      return { cls: 'vis-move', tone: 'write', verb: op === 'copy' ? 'Copying' : (op === 'rename' ? 'Renaming' : 'Moving'), detail: bn(args.src) };
    }
    if (name === 'clipboard') {
      if (String(args.op) === 'set') return { cls: 'vis-clip', tone: 'write', verb: 'Copying to clipboard', detail: cut(args.text, 40) };
      return { cls: 'vis-clip', tone: 'info', verb: 'Reading the clipboard', detail: '' };
    }
    if (name === 'power') return { cls: 'vis-power', tone: String(args.action) === 'abort' ? 'info' : 'danger', verb: 'Power: ' + args.action, detail: '' };
    const m = ACT_META[name];
    if (!m) return { cls: 'vis-pulse', tone: 'info', verb: 'Working…', detail: '' };
    return { cls: m.cls, tone: m.tone, verb: m.verb, detail: m.pick ? String(m.pick(args) == null ? '' : m.pick(args)) : '' };
  }
  function showAction(name, args) {
    const s = actFor(name, args);
    if (S.stageTimer) { clearTimeout(S.stageTimer); S.stageTimer = null; }
    els.stage.dataset.tone = s.tone;
    els.stage.className = 'action-stage busy';
    els.stage.hidden = false;
    els.stageVis.className = 'stage-vis ' + s.cls;
    els.stageVis.innerHTML = sceneHtml(s.cls);
    els.stageVerb.textContent = s.verb;
    els.stageDetail.textContent = s.detail || '';
  }
  function settleAction(name, ok) {
    if (els.stage.hidden) return;
    els.stage.classList.remove('busy');
    els.stage.classList.add(ok ? 'done' : 'fail');
    if (ok && els.stage.dataset.tone !== 'danger') els.stage.dataset.tone = 'ok';
    if (S.stageTimer) clearTimeout(S.stageTimer);
    S.stageTimer = setTimeout(() => { els.stage.hidden = true; els.stage.className = 'action-stage'; }, 1500);
  }

  /* ---------- tool activity feed ---------- */
  function argSummary(name, args) {
    args = args || {};
    const v = name === 'manage_files' ? (args.op + (args.dest ? ' → ' + bn(args.dest) : '')) : (args.command || args.path || args.url || args.query || args.app || args.target || args.text || args.op || args.action || args.key || '');
    return cut(String(v || ''), 90);
  }
  function addActivity(name, args) {
    const row = document.createElement('div');
    row.className = 'row pending';
    row.innerHTML = '<span class="name">' + esc(name) + '</span><span class="arg" title="' + esc(argSummary(name, args)) + '">' + esc(argSummary(name, args) || '…') + '</span><span class="st"><i data-lucide="loader-2"></i></span>';
    els.activity.prepend(row);
    try { lucide.createIcons(); } catch (e) {}
    (S.actQueue[name] = S.actQueue[name] || []).push(row);
    bumpBadge(1);
    return row;
  }
  function settleActivity(ev) {
    const name = ev.name;
    const q = S.actQueue[name] || [];
    const row = q.shift();
    if (!row) return;
    row.classList.remove('pending');
    const ok = ev.ok === true;
    row.classList.add(ok ? 'ok' : 'err');
    const st = row.querySelector('.st');
    if (st) st.innerHTML = '<i data-lucide="' + (ev.cancelled ? 'ban' : (ok ? 'check' : 'x')) + '"></i>';
    if (!ok && (ev.error || ev.cancelled)) { const ar = row.querySelector('.arg'); if (ar) { ar.textContent = cut(ev.cancelled ? 'cancelled' : ev.error, 120); ar.title = ev.error || 'cancelled'; } }
    else if (ev.preview) { const ar = row.querySelector('.arg'); if (ar) ar.title = String(ev.preview).slice(0, 500); }
    try { lucide.createIcons(); } catch (e) {}
    // any read-tool that produced a memory/search signal
    noteMemoryTool(name);
  }
  function logApproval(name, approved) {
    const it = document.createElement('div');
    it.className = 'ap-item ' + (approved ? 'yes' : 'no');
    it.innerHTML = '<span class="ap-dot"></span><span class="ap-name">' + esc(name) + '</span><span class="ap-dec">' + (approved ? 'Approved' : 'Denied') + '</span><span class="ap-when">' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>';
    els.approvalLog.prepend(it);
    while (els.approvalLog.children.length > 60) els.approvalLog.removeChild(els.approvalLog.lastChild);
  }
  function bumpBadge(n) {
    S.actCount += n;
    if (S.tab === 'activity') { S.actCount = 0; els.actBadge.hidden = true; return; }
    if (S.actCount > 0) { els.actBadge.hidden = false; els.actBadge.textContent = S.actCount > 99 ? '99+' : S.actCount; }
    else els.actBadge.hidden = true;
  }

  /* ---------- inline per-turn tool-call trace ----------
     A compact, collapsible timeline attached to the assistant reply currently being
     streamed: one row per tool call with name, a short arg summary, status and how long
     it took. It sits alongside the global Activity tab (which stays the running log).
     The list is re-rendered from S.trace each time, so a provider failover (which swaps
     the live bubble) can never orphan the timeline. */
  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '';
    return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
  }
  function traceShell() {
    if (S.traceEl && S.traceEl.isConnected) return S.traceEl;
    const col = liveBubble && liveBubble.closest('.msg-col');
    if (!col) return null;
    const el = document.createElement('div');
    el.className = 'trace';
    el.innerHTML =
      '<button class="trace-head" type="button" aria-expanded="true">' +
        '<i data-lucide="chevron-down" class="trace-chev"></i>' +
        '<i data-lucide="list-checks" class="trace-ic"></i>' +
        '<span class="trace-title">Working…</span>' +
        '<span class="trace-meta"></span>' +
      '</button>' +
      '<div class="trace-list"></div>';
    const actions = col.querySelector('.msg-actions');
    if (actions) col.insertBefore(el, actions); else col.appendChild(el);
    el.querySelector('.trace-head').onclick = () => {
      const open = el.dataset.open !== '0';
      el.dataset.open = open ? '0' : '1';
      el.querySelector('.trace-list').hidden = open;
      el.querySelector('.trace-head').setAttribute('aria-expanded', String(!open));
    };
    S.traceEl = el;
    return el;
  }
  function renderTrace() {
    const el = traceShell();
    if (!el) return;
    const list = el.querySelector('.trace-list');
    const head = el.querySelector('.trace-head');
    list.innerHTML = S.trace.map(t => {
      const cls = t.status === 'run' ? 'run' : (t.status === 'ok' ? 'ok' : (t.status === 'cancelled' ? 'cancelled' : 'err'));
      const icon = t.status === 'run' ? 'loader-2' : (t.status === 'ok' ? 'check' : (t.status === 'cancelled' ? 'ban' : 'x'));
      const argTxt = (t.status === 'run' || t.status === 'ok') ? (argSummary(t.name, t.args) || '…') : (t.status === 'cancelled' ? 'cancelled' : cut(t.error || '', 60));
      const argTitle = t.preview ? String(t.preview).slice(0, 500) : (t.error || '');
      return '<div class="trace-row ' + cls + '">' +
        '<span class="tr-name">' + esc(t.name) + '</span>' +
        '<span class="tr-arg" title="' + esc(argTitle) + '">' + esc(argTxt) + '</span>' +
        '<span class="tr-ms">' + esc(fmtMs(t.ms)) + '</span>' +
        '<span class="tr-st"><i data-lucide="' + icon + '"></i></span>' +
      '</div>';
    }).join('');
    const total = S.trace.length;
    const done = S.trace.filter(t => t.status !== 'run').length;
    const title = el.querySelector('.trace-title');
    const meta = el.querySelector('.trace-meta');
    if (S.traceDone) {
      if (title) title.textContent = total + (total === 1 ? ' step' : ' steps');
      if (meta) meta.textContent = Math.round((nowMs() - S.turnStart) / 1000) + 's';
      el.dataset.open = '0'; list.hidden = true; head.setAttribute('aria-expanded', 'false');
    } else {
      if (title) title.textContent = 'Working…';
      if (meta) meta.textContent = total ? (done + '/' + total) : '';
      el.dataset.open = '1'; list.hidden = false; head.setAttribute('aria-expanded', 'true');
    }
    try { lucide.createIcons(); } catch (e) {}
  }
  function traceAdd(ev) {
    S.trace.push({ id: ev.id, name: ev.name, args: ev.args, status: 'run', t0: nowMs() });
    renderTrace();
  }
  function traceSettle(ev) {
    let e = (ev.id != null) ? S.trace.find(t => t.id === ev.id && t.status === 'run') : null;
    if (!e) e = S.trace.find(t => t.name === ev.name && t.status === 'run');
    if (!e) return;
    e.status = ev.ok ? 'ok' : (ev.cancelled ? 'cancelled' : 'err');
    e.ms = ev.ms; e.preview = ev.preview; e.error = ev.error;
    renderTrace();
  }
  function traceFinish() {
    if (!S.trace.length) return;                 // plain text reply — no trace bar at all
    S.traceDone = true;
    renderTrace();
  }

  /* ---------- semantic-memory intent counters (payloads don't reach the client) ---------- */
  function noteMemoryTool(name) {
    let touched = true;
    if (name === 'index_files') S.memc.index++;
    else if (name === 'memory_search') S.memc.search++;
    else if (name === 'memory_stats') S.memc.stats++;
    else if (name === 'memory_forget') S.memc.forget = 0;
    else touched = false;
    if (touched) { ls('majin_memc', JSON.stringify(S.memc)); renderMemoryStats(); }
  }

  /* ---------- screenshots & lightbox ---------- */
  function showShot(data) {
    const b64 = String(data || ''); if (!b64) return;
    const src = 'data:image/png;base64,' + b64;
    S.lastAttachUrl = src;
    renderWorkspace({ title: 'Screen capture', blocks: [{ type: 'image', url: src, title: 'Majin captured your screen — click to enlarge' }] });
  }
  function openLight(src) { els.lightboxImg.src = safeUrl(src); els.lightbox.hidden = false; }
  function closeLight() { els.lightbox.hidden = true; els.lightboxImg.removeAttribute('src'); }
  if (els.lightbox) els.lightbox.onclick = closeLight;

  /* ---------- toast + confetti ---------- */
  function toast(title, msg) {
    if (!els.toastHost) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<span class="tt">' + esc(title) + '</span><span>' + esc(msg || '') + '</span>';
    els.toastHost.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 430); }, 3600);
  }
  function celebrate() {
    if (!els.confetti || els.root.classList.contains('no-motion')) return;
    const colors = ['#6366f1', '#22d3ee', '#22c55e', '#f59e0b', '#f43f5e'];
    for (let i = 0; i < 46; i++) {
      const b = document.createElement('div');
      b.className = 'confetti-bit';
      b.style.left = (Math.random() * 100) + 'vw';
      b.style.background = colors[i % colors.length];
      b.style.animationDuration = (1.1 + Math.random() * 0.9) + 's';
      b.style.animationDelay = (Math.random() * 0.25) + 's';
      els.confetti.appendChild(b);
      b.addEventListener('animationend', () => b.remove());
    }
  }
  /* ---------- confirmation gate (server enforces this; the client just shows it) ----------
     The server pauses on any risky tool and waits for us. When auto-approve is ON it
     means "run everything" — commands, file writes and deletions included — so we
     approve every request without the modal. When it's OFF, each risky action asks. */
  const DESTRUCTIVE = new Set(['power', 'kill_process', 'run_command', 'install', 'manage_files',
    'memory_forget', 'index_files', 'write_file', 'click', 'drag', 'scroll', 'type_text', 'press_keys', 'move_mouse']);
  const isDestructiveAction = name => DESTRUCTIVE.has(String(name));

  function postConfirm(id, approved) { postJSON('/api/confirm', { id, approved }).catch(() => {}); }
  function askConfirm(ev) {
    if (S.autoApprove) {
      logApproval(ev.name, true);
      postConfirm(ev.id, true);
      return;
    }
    S.pendingConfirm = { id: ev.id, name: ev.name };
    els.confirmTool.textContent = ev.name + '  ' + JSON.stringify(ev.args || {}, null, 1).slice(0, 400);
    els.confirmReason.textContent = ev.reason || ('Majin wants to use ' + ev.name + '.');
    els.confirmArgs.textContent = JSON.stringify(ev.args || {}, null, 2);
    els.confirmModal.hidden = false;
    setTimeout(() => { try { els.approve.focus(); } catch (e) {} }, 30);
  }
  function resolveConfirm(approved) {
    const pc = S.pendingConfirm;
    if (!pc) return;
    S.pendingConfirm = null;
    els.confirmModal.hidden = true;
    postConfirm(pc.id, approved);
    logApproval(pc.name, approved);
  }
  els.approve.onclick = () => resolveConfirm(true);
  els.deny.onclick = () => resolveConfirm(false);

  /* ---------- auto-approve (top bar) ---------- */
  function paintAutoApprove() {
    els.autoBtn.classList.toggle('armed', !!S.autoApprove);
    paintBtnIcon(els.autoBtn, S.autoApprove ? 'shield-alert' : 'shield');
    els.autoBtn.title = S.autoApprove
      ? 'Auto-approve is ON — every action runs without asking (commands, file create/delete, clicks, all of it)'
      : 'Auto-approve is OFF — each risky action asks first';
  }
  els.autoBtn.onclick = () => {
    S.autoApprove = !S.autoApprove;
    ls('majin_auto_approve', S.autoApprove ? '1' : '0');
    paintAutoApprove();
    toast('Auto-approve', S.autoApprove ? 'All actions now run automatically' : 'Risky actions will ask first');
  };

  /* ---------- provider / model / keys  (all via /api/config) ---------- */
  async function loadConfig() {
    try { const r = await fetch('/api/config'); S.CFG = await r.json(); }
    catch (e) { S.CFG = S.CFG || { provider: 'gemini', model: '', hasKey: false, providers: [{ id: 'gemini', label: 'Google Gemini' }] }; }
    return S.CFG;
  }
  function paintKeyStatus() {
    const c = S.CFG || {};
    const bits = ['gemini', 'groq', 'freellm'].filter(p => c[p] && c[p].hasKey).map(p => providerLabel(p));
    if (els.geminiMask) els.geminiMask.textContent = c.gemini && c.gemini.hasKey ? c.gemini.keyMask : 'not set';
    if (els.groqMask) els.groqMask.textContent = c.groq && c.groq.hasKey ? c.groq.keyMask : 'not set';
    if (els.freellmMask) els.freellmMask.textContent = c.freellm && c.freellm.hasKey ? c.freellm.keyMask : 'not set';
    if (els.keyStatus) els.keyStatus.textContent = bits.length ? ('Saved keys: ' + bits.join(', ') + ' · active: ' + providerLabel(c.provider)) : 'No API key saved yet — add one to start chatting.';
  }
  function fillProviders() {
    if (!els.providerSelect) return;
    const c = S.CFG || {};
    const list = (c.providers && c.providers.length) ? c.providers : [{ id: 'gemini', label: 'Google Gemini' }, { id: 'groq', label: 'Groq' }, { id: 'freellm', label: 'FreeLLMAPI (free pool)' }];
    els.providerSelect.innerHTML = list.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
    els.providerSelect.value = c.provider || 'gemini';
  }
  async function loadModels(preferred) {
    const c = S.CFG || {};
    const provider = els.providerSelect ? els.providerSelect.value : c.provider;
    if (els.modelsLoading) { els.modelsLoading.hidden = false; els.modelsLoading.textContent = 'Loading models…'; }
    els.modelSelect.innerHTML = '';
    let models = null, err = '';
    try { const r = await fetch('/api/models?provider=' + encodeURIComponent(provider)); const j = await r.json(); if (j.error) err = j.error; else models = j.models; }
    catch (e) { err = 'Could not reach the model list'; }
    const def = (c.providers || []).find(p => p.id === provider);
    const defModel = preferred || c.model || (def && def.defaultModel) || '';
    if (!models || !models.length) {
      els.modelSelect.innerHTML = `<option value="${esc(defModel)}">${esc(defModel || 'default')}${models ? '' : ' (default — ' + esc(err || 'add a key') + ')'}</option>`;
      if (els.modelsLoading) { els.modelsLoading.textContent = err || ''; els.modelsLoading.hidden = !err; }
      return;
    }
    if (els.modelsLoading) els.modelsLoading.hidden = true;
    els.modelSelect.innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`).join('');
    const cur = models.some(m => m.id === c.model) ? c.model : defModel;
    if (cur) els.modelSelect.value = cur;
  }
  async function openSettings() {
    await loadConfig();
    const c = S.CFG || {};
    fillProviders(); paintKeyStatus();
    els.apiKeyInput.value = ''; els.groqKeyInput.value = ''; els.freellmKeyInput.value = '';
    els.freellmBaseInput.value = (c.freellm && c.freellm.baseUrl) || '';
    if (els.motionToggle) els.motionToggle.checked = !els.root.classList.contains('no-motion');
    els.keyError.hidden = true;
    els.settingsModal.hidden = false;
    loadModels();
  }
  function closeSettings() { els.settingsModal.hidden = true; }
  async function saveSettings() {
    const body = { provider: els.providerSelect.value };
    if (els.modelSelect.value) body.model = els.modelSelect.value;
    if (els.apiKeyInput.value.trim()) body.geminiKey = els.apiKeyInput.value.trim();
    if (els.groqKeyInput.value.trim()) body.groqKey = els.groqKeyInput.value.trim();
    if (els.freellmKeyInput.value.trim()) body.freellmKey = els.freellmKeyInput.value.trim();
    if (els.freellmBaseInput.value.trim()) body.freellmBaseUrl = els.freellmBaseInput.value.trim();
    els.saveKey.disabled = true;
    try {
      const r = await postJSON('/api/config', body);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not save settings');
      S.CFG = j;
      els.keyError.hidden = true;
      closeSettings();
      checkStatus(); refreshModelChip(); paintAutoApprove();
      celebrate();
      toast('Settings saved', providerLabel(j.provider) + ' · ' + j.model);
    } catch (e) {
      els.keyError.textContent = e.message || 'Could not save'; els.keyError.hidden = false;
    } finally { els.saveKey.disabled = false; }
  }
  els.settings.onclick = openSettings;
  els.settingsClose.onclick = closeSettings;
  els.cancelKey.onclick = closeSettings;
  els.saveKey.onclick = saveSettings;
  els.providerSelect.onchange = () => loadModels();
  els.refreshModelsBtn.onclick = () => loadModels();
  if (els.motionToggle) els.motionToggle.onchange = () => {
    S.motion = els.motionToggle.checked;
    ls('majin_motion', S.motion ? '1' : '0');
    applyMotion();
  };
  [els.settingsModal, els.confirmModal].forEach(m => m.addEventListener('mousedown', e => { if (e.target === m) { if (m === els.settingsModal) closeSettings(); } }));
  // show / hide each key
  function wireVis(btn, input) {
    if (!btn || !input) return;
    btn.onclick = () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      paintBtnIcon(btn, show ? 'eye-off' : 'eye');
    };
  }
  wireVis(els.keyVisBtn, els.apiKeyInput);
  wireVis(els.groqVisBtn, els.groqKeyInput);
  wireVis(els.freellmVisBtn, els.freellmKeyInput);

  /* ---------- composer quick model-switch ---------- */
  let MODELS = null;
  async function refreshModelChip() {
    try { const r = await fetch('/api/status'); const j = await r.json(); if (els.modelChipLabel) els.modelChipLabel.textContent = j.hasKey ? j.model : 'no key'; }
    catch (e) { if (els.modelChipLabel) els.modelChipLabel.textContent = 'model'; }
  }
  async function loadModelCache() {
    const c = S.CFG || await loadConfig();
    try { const r = await fetch('/api/models?provider=' + encodeURIComponent(c.provider)); const j = await r.json(); MODELS = j.models || null; }
    catch (e) { MODELS = null; }
    return MODELS;
  }
  function renderModelPop() {
    const c = S.CFG || {};
    const list = MODELS && MODELS.length ? MODELS : [{ id: c.model, label: c.model || 'default' }];
    els.modelPop.innerHTML = '<div class="mp-lab">' + esc(providerLabel(c.provider)) + ' models</div>' +
      list.map(m => `<div class="mp-opt${m.id === c.model ? ' sel' : ''}" data-id="${esc(m.id)}"><span>${esc(m.label || m.id)}</span><i data-lucide="check" class="mp-check"></i></div>`).join('');
    els.modelPop.hidden = false;
    try { lucide.createIcons(); } catch (e) {}
  }
  async function toggleModelPop(force) {
    const open = force != null ? force : els.modelPop.hidden;
    if (!open) { els.modelPop.hidden = true; return; }
    els.modelPop.hidden = true;
    await loadModelCache();
    renderModelPop();
  }
  els.modelChip.onclick = e => { e.stopPropagation(); toggleModelPop(); };
  els.modelPop.addEventListener('click', async e => {
    const opt = e.target.closest('.mp-opt'); if (!opt) return;
    const id = opt.dataset.id; if (!id) return;
    try { const r = await postJSON('/api/config', { model: id }); const j = await r.json(); if (r.ok) { S.CFG = Object.assign(S.CFG || {}, j); toast('Model switched', id); } } catch (err) {}
    els.modelPop.hidden = true;
    checkStatus(); refreshModelChip();
  });
  document.addEventListener('click', e => { if (!els.modelPop.hidden && !e.target.closest('#modelPop') && !e.target.closest('#modelChip')) els.modelPop.hidden = true; });

  /* ---------- working folder (cwd) — pinned per conversation, told to the model ---------- */
  function refreshCwdChip() {
    const cwd = S.active && S.active.cwd;
    if (els.cwdChipLabel) els.cwdChipLabel.textContent = cwd ? bn(cwd) : 'cwd';
    els.cwdChip.classList.toggle('armed', !!cwd);
    els.cwdChip.title = cwd ? ('Working folder: ' + cwd + ' — click to change') : 'Pin a working folder to this conversation';
    renderTray();
  }
  els.cwdChip.onclick = () => {
    const cwd = (S.active && S.active.cwd) || '';
    const nt = window.prompt('Working folder for this chat (leave blank to clear):', cwd);
    if (nt == null) return;
    setThreadCwd(nt.trim());
  };
  function setThreadCwd(v) {
    const t = curThread(); if (t) { t.cwd = v || ''; saveThreads(); }
    refreshCwdChip();
    toast('Working folder', v ? bn(v) : 'cleared');
  }

  /* ---------- context tray (attached image + pinned folder) ---------- */
  function renderTray() {
    if (!els.ctxTray) return;
    els.ctxTray.innerHTML = '';
    let shown = false;
    if (S.attach) {
      shown = true;
      const chip = document.createElement('div');
      chip.className = 'fchip';
      chip.innerHTML = '<img src="' + safeUrl(S.attach.preview) + '" alt=""><span>' + esc(cut(S.attach.name || 'image', 26)) + '</span><button type="button" title="Remove">✕</button>';
      chip.querySelector('button').onclick = clearAttach;
      els.ctxTray.appendChild(chip);
    }
    const cwd = S.active && S.active.cwd;
    if (cwd) {
      shown = true;
      const chip = document.createElement('div');
      chip.className = 'ctx-chip';
      chip.innerHTML = '<i data-lucide="folder"></i><span>' + esc(cut(cwd, 40)) + '</span>';
      els.ctxTray.appendChild(chip);
    }
    els.ctxTray.hidden = !shown;
    try { lucide.createIcons(); } catch (e) {}
  }

  /* ---------- the agent turn (SSE streaming from /api/agent) ---------- */
  function setBusy(b) {
    S.busy = b;
    els.stop.hidden = !b;
    els.send.hidden = b;
    els.input.disabled = b;
    if (!b) els.busy.textContent = '';
    else if (!S.turnTools) els.busy.textContent = 'thinking…';
  }
  function updateBusyCount() { els.busy.textContent = 'working · ' + S.turnTools + ' tool' + (S.turnTools === 1 ? '' : 's'); }
  function reportMetrics(sec, tools) {
    els.sbMetrics.innerHTML = '<span class="sb-val">' + (sec || 0) + 's</span> · <span class="sb-val">' + tools + ' tool' + (tools === 1 ? '' : 's') + '</span>';
  }
  async function runTurn(text, images) {
    images = images || [];
    const userTurn = { role: 'user', content: text };
    if (images.length) userTurn.images = images.map(im => ({ mime: im.mime || 'image/png', data: im.data }));
    S.history.push(userTurn);
    persistActiveHistory();
    S.turnStart = nowMs(); S.turnTools = 0;
    S.trace = []; S.traceEl = null; S.traceDone = false;
    setBusy(true);
    const ctrl = new AbortController(); S.abort = ctrl;
    ensureLive();
    const tok = await ensureToken();
    let res;
    try {
      res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Majin-Token': tok || '' },
        body: JSON.stringify({ history: S.history.slice(0, -1), message: text, images }),
        signal: ctrl.signal
      });
    } catch (e) { handleRunEnd(e); return; }
    if (!res.ok || !res.body) {
      let msg = 'Request failed (' + res.status + ')';
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
      handleRunEnd();
      addMsg('model', '⚠️ ' + msg);
      return;
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          if (!line || line[0] === ':' || line.slice(0, 5) !== 'data:') continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let ev; try { ev = JSON.parse(payload); } catch (e) { continue; }
          handleEvent(ev);
        }
      }
    } catch (e) { handleRunEnd(e); return; }
    handleRunEnd();
  }
  function handleRunEnd(e) {
    S.abort = null; setBusy(false);
    traceFinish();
    if (e) {
      if (e.name === 'AbortError') { finishLive(); toast('Stopped', 'Generation stopped'); }
      else { finishLive(); addMsg('model', '⚠️ ' + (e.message || String(e))); }
      return;
    }
    saveActive();
  }
  function stopTurn() { if (S.abort) { try { S.abort.abort(); } catch (e) {} } }
  els.stop.onclick = stopTurn;

  function handleEvent(ev) {
    switch (ev.type) {
      case 'token': appendLive(ev.text); break;
      case 'reset_text': finishLive(); ensureLive(); break;
      case 'notice': showNotice(ev.text); break;
      case 'tool':
        S.turnTools++; updateBusyCount();
        showAction(ev.name, ev.args); addActivity(ev.name, ev.args); traceAdd(ev);
        break;
      case 'tool_result':
        settleAction(ev.name, ev.ok === true); settleActivity(ev); maybeRememberHit(ev); traceSettle(ev);
        break;
      case 'confirm': askConfirm(ev); break;
      case 'workspace': renderWorkspace(ev); break;
      case 'shot': showShot(ev.data); break;
      case 'reminder': handleReminderEvent(ev); break;
      case 'done': onDone(ev); break;
      case 'error':
        finishLive(); addMsg('model', '⚠️ ' + (ev.error || 'Something went wrong'));
        toast('Error', cut(ev.error || 'error', 80));
        break;
    }
  }
  function showNotice(text) {
    if (liveBubble && liveBubble.dataset.thinking) startThinking(text);
    else toast('Status', text);
  }
  function onDone(ev) {
    const reply = liveBubble ? (liveBubble.dataset.raw || '') : '';
    finishLive();
    if (Array.isArray(ev.turnContents)) { S.history = S.history.concat(ev.turnContents); persistActiveHistory(); }
    if (ev.provider) S.CFG = Object.assign(S.CFG || {}, { provider: ev.provider, model: ev.model });
    reportMetrics(Math.round((nowMs() - S.turnStart) / 1000), S.turnTools);
    checkStatus(); refreshModelChip();
    if (ev.note) toast('Heads up', ev.note);
    speak(reply);
  }

  /* ---------- send + composer autosize ---------- */
  function autosize() { els.input.style.height = 'auto'; els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px'; }
  function doSend() {
    if (S.busy) return;
    const text = els.input.value.trim();
    if (!text && !S.attach) return;
    if (S.recognising) stopVoice();
    if (text[0] === '/' && !S.attach) { els.input.value = ''; autosize(); hideSuggest(); runSlashCommand(text); return; }
    els.input.value = ''; autosize(); hideSuggest();
    const imgs = [];
    if (S.attach) imgs.push(S.attach.payload);
    clearAttach();
    const fallback = 'Look at the attached image.';
    const body = text || fallback;
    addMsg('user', body, imgs);
    maybeAutoTitle(text || 'Image question');
    runTurn(body, imgs);
  }
  els.form.addEventListener('submit', e => { e.preventDefault(); doSend(); });
  els.input.addEventListener('keydown', e => {
    if (handleSuggestKeys(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  els.input.addEventListener('input', () => { autosize(); saveDraft(); handleInputSuggestions(); });
  els.input.addEventListener('paste', e => {
    const it = (e.clipboardData && e.clipboardData.items) || [];
    for (const f of it) { if (f.type && f.type.startsWith('image/')) { const file = f.getAsFile(); if (file) { setAttach(file); e.preventDefault(); } break; } }
  });

  /* ---------- image attach ---------- */
  function setAttach(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) { toast('Attach', 'Only images are supported'); return; }
    if (file.size > 8 * 1024 * 1024) { toast('Attach', 'Image is too large (8 MB cap)'); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = String(fr.result || '');
      const comma = dataUrl.indexOf(',');
      S.attach = { name: file.name || 'pasted-image.png', mime: file.type || 'image/png', preview: dataUrl, payload: { mime: file.type || 'image/png', data: dataUrl.slice(comma + 1) } };
      renderTray();
      els.attach.classList.add('armed');
    };
    fr.onerror = () => toast('Attach', 'Could not read that image');
    fr.readAsDataURL(file);
  }
  function clearAttach() { S.attach = null; renderTray(); els.attach.classList.remove('armed'); els.imgInput.value = ''; }
  els.attach.onclick = () => els.imgInput.click();
  els.imgInput.onchange = e => { if (e.target.files && e.target.files[0]) setAttach(e.target.files[0]); };

  /* ---------- Vision: launch the floating screen-share pill ----------
     The pill is a self-contained page (public/vision.html + js/vision.js). We host it
     on the best always-on-top surface available:
       • Desktop (Electron): window.open is intercepted by main.js and turned into a
         transparent, frameless, screen-saver-level window — truly see-through.
       • Browser: a Document Picture-in-Picture window — borderless and always-on-top
         over EVERY app. A PiP window can't navigate, so we fetch vision.html, pin a
         <base> to our origin, drop its markup in, and re-run its scripts. This is what
         makes it a real overlay instead of a browser tab.
       • Neither available: open nothing rather than a framed window (no buttons ever). */
  function visionUrl() {
    return location.origin + String(location.pathname || '/').replace(/index\.html$/i, '') + 'vision.html';
  }
  function openVisionOverlay() {
    if (VISION_PIP && !VISION_PIP.closed) { try { VISION_PIP.focus(); } catch (e) {} return; }
    const isElectron = /electron/i.test(String(navigator.userAgent || ''));
    // Desktop app: main.js intercepts this and opens a frameless, transparent,
    // always-on-top window — no minimize / maximize / close buttons at all (we draw
    // our own close inside the pill).
    if (isElectron) { try { window.open(visionUrl(), 'MajinVision', 'popup=yes,width=600,height=440'); } catch (e) {} return; }
    // Browser: Document Picture-in-Picture is the only borderless floating window a web
    // page can open (it has just a close button — a browser-enforced minimum, no min/max).
    const DPR = window.documentPictureInPicture;
    if (DPR && typeof DPR.requestWindow === 'function') {
      let p = null;
      try { p = DPR.requestWindow({ width: 560, height: 132, disallowReturnToOpener: true }); } catch (e) { p = null; }
      if (p && typeof p.then === 'function') { p.then(mountVisionInPip).catch(visionNeedsApp); return; }
    }
    // Neither is available: do NOT open a normal window (that would bring the buttons back).
    visionNeedsApp();
  }
  async function mountVisionInPip(pipWin) {
    VISION_PIP = pipWin;
    try { pipWin.addEventListener('pagehide', () => { VISION_PIP = null; }, { once: true }); } catch (e) {}
    try {
      const base = location.origin + String(location.pathname || '/').replace(/index\.html$/i, '');
      const html = await (await fetch(base + 'vision.html', { cache: 'no-store' })).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // A PiP window has no URL of its own, so pin relative assets + /api fetches to our origin.
      const baseEl = doc.createElement('base'); baseEl.href = base;
      doc.head.insertBefore(baseEl, doc.head.firstChild);
      pipWin.document.documentElement.innerHTML = doc.documentElement.innerHTML;
      pipWin.document.documentElement.setAttribute('data-pip', '1');   // opaque dark backdrop
      // Scripts inserted via innerHTML never execute — re-create them so vision.js runs.
      pipWin.document.querySelectorAll('script').forEach(s => {
        const n = pipWin.document.createElement('script');
        if (s.src) { n.src = s.src; n.async = false; } else { n.textContent = s.textContent; }
        s.parentNode.replaceChild(n, s);
      });
    } catch (e) {
      // Keep the borderless window and explain inside it — never degrade to a framed popup here.
      try {
        const b = pipWin.document.body; if (!b) return;
        b.innerHTML = '';
        const msg = pipWin.document.createElement('div');
        msg.textContent = 'Vision overlay failed to load: ' + ((e && e.message) || e) + '. The desktop app (npm run app) always works.';
        msg.style.cssText = 'font:13px system-ui;color:#e6edf6;background:#0d1420;padding:14px;border-radius:14px;margin:8px;line-height:1.5';
        b.appendChild(msg);
      } catch (x) {}
    }
  }
  function visionNeedsApp() {
    toast('Vision overlay', 'A button-less floating bar needs the desktop app (npm run app) or Chrome/Edge 116+ (Picture-in-Picture). This browser can\'t hide its window buttons, so nothing was opened.');
  }
  if (els.screen) els.screen.onclick = () => { try { openVisionOverlay(); } catch (e) {} };

  function maybeAutoTitle(text) {
    const t = curThread(); if (!t || !text) return;
    if (!t.title || t.title === 'New chat') { t.title = cut(text, 48); renderThreadList(); saveThreads(); updateStatusbarThread(); }
    t.updated = nowMs();
  }

  /* ---------- lucide-safe icon repaint ----------
     lucide.createIcons() REPLACES the <i data-lucide> element with a new <svg>
     (parentNode.replaceChild), so the original <i> reference is detached after the
     first paint and can no longer be mutated to change the icon. For a button whose
     ONLY child is its icon we redraw through the (always-live) button instead. */
  function paintBtnIcon(btn, name) {
    if (!btn) return;
    btn.innerHTML = '<i data-lucide="' + esc(name) + '"></i>';
    try { lucide.createIcons(); } catch (e) {}
  }

  /* ---------- workspace tab controller ---------- */
  function openWsOverlay() { if (window.matchMedia && window.matchMedia('(max-width:860px)').matches) els.shell.classList.add('ws-open'); }
  function closeWsOverlay() { els.shell.classList.remove('ws-open'); }
  function setTab(name, reveal) {
    S.tab = name;
    els.wsTabs.querySelectorAll('.ws-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.ws-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    if (name === 'activity' && els.actBadge) { els.actBadge.hidden = true; els.actBadge.textContent = '0'; }
    if (reveal) openWsOverlay();
  }
  els.wsTabs.addEventListener('click', e => { const b = e.target.closest('.ws-tab'); if (b && b.dataset.tab) setTab(b.dataset.tab); });

  function emptyHtml(icon, title, sub) {
    return '<div class="empty-state"><div class="empty-ic"><i data-lucide="' + esc(icon) + '"></i></div><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p></div>';
  }
  function clearActivePanel() {
    const n = S.tab;
    if (n === 'canvas') {
      els.blocks.innerHTML = ''; S.blocks = 0;
      if (els.wsTitle) els.wsTitle.hidden = true;
      if (els.emptyCanvas) els.emptyCanvas.hidden = false;
    } else if (n === 'project') {
      els.projectBody.innerHTML = emptyHtml('network', 'Project map', 'Point Majin at a code folder to visualise its modules, dependencies, hot files and health — then click any file to read it.');
      lucide.createIcons();
    } else if (n === 'reader') {
      els.readerBody.innerHTML = emptyHtml('globe', 'Reader', "Fetch a web page as clean article text, open a PDF, or pull a YouTube video's captions — all local, all private.");
      S.readerUrl = ''; lucide.createIcons();
    } else if (n === 'memory') {
      els.memoryHits.innerHTML = '<span class="muted">Results from memory_search land here.</span>';
    } else if (n === 'activity') {
      els.activity.innerHTML = '';
      els.approvalLog.innerHTML = '<span class="muted">Confirmed &amp; denied actions are recorded here.</span>';
      if (els.actBadge) { els.actBadge.hidden = true; els.actBadge.textContent = '0'; }
    }
    toast('Workspace', 'Panel cleared');
  }
  els.clearWorkspace.onclick = clearActivePanel;

  /* ---------- slash commands ---------- */
  const SLASH = [
    { cmd: 'help', icon: 'sparkles', desc: 'Show what Majin can do' },
    { cmd: 'new', icon: 'plus', desc: 'Start a new conversation' },
    { cmd: 'clear', icon: 'eraser', desc: 'Clear the current workspace panel' },
    { cmd: 'theme', icon: 'moon', desc: 'Cycle theme: system → light → dark' },
    { cmd: 'auto', icon: 'shield', desc: 'Toggle auto-approve of safe actions' },
    { cmd: 'tts', icon: 'volume-2', desc: 'Toggle spoken replies' },
    { cmd: 'export', icon: 'download', desc: 'Export this chat as Markdown' },
    { cmd: 'scan', icon: 'radar', desc: 'Map a project folder → Project tab   (path)' },
    { cmd: 'read', icon: 'globe', desc: 'Read a URL / PDF / video → Reader tab   (url)' },
    { cmd: 'memory', icon: 'brain', desc: 'Open the Memory tab' },
    { cmd: 'activity', icon: 'activity', desc: 'Open the Activity log' },
    { cmd: 'settings', icon: 'settings', desc: 'Provider, model & API keys' },
    { cmd: 'stop', icon: 'square', desc: 'Stop the current generation' },
  ];
  function renderHelp() {
    renderWorkspace({
      title: 'Quick start',
      blocks: [
        { type: 'text', body: 'Majin is a local assistant that can **explain, build and do**. Every tool runs through a live action HUD, structured output lands on the Canvas, and anything risky asks for your approval first.' },
        { type: 'list', title: 'Slash commands', items: SLASH.map(s => '**/' + s.cmd + '** — ' + s.desc) },
        { type: 'list', title: 'Handy shortcuts', items: ['`Ctrl / ⌘ + K` — command palette', '`Ctrl / ⌘ + ]` — toggle the conversation rail', '`Esc` — stop generating / close any overlay', '`@` in the box — reference a file from your scanned project', '`Enter` send · `Shift+Enter` newline'] },
        { type: 'callout', tone: 'info', body: 'Add a provider API key in **Settings** to start chatting. Keys stay in the `.env` next to `server.js`.' },
      ],
    });
  }
  function runSlashCommand(text) {
    const m = /^\/([a-zA-Z]+)\s*([\s\S]*)$/.exec(String(text || '').trim());
    const cmd = m ? m[1].toLowerCase() : '';
    const rest = m ? (m[2] || '').trim() : '';
    addMsg('user', text);
    switch (cmd) {
      case 'help': renderHelp(); break;
      case 'new': newThread(); break;
      case 'clear': clearActivePanel(); break;
      case 'theme': cycleTheme(); break;
      case 'auto': els.autoBtn.click(); break;
      case 'tts': toggleTts(); break;
      case 'export': exportActive(); break;
      case 'scan': setTab('project', true); if (rest) scanProject(rest); else els.scanPath.focus(); break;
      case 'read': setTab('reader', true); if (rest) readLink(rest); else els.readUrl.focus(); break;
      case 'memory': setTab('memory', true); break;
      case 'activity': setTab('activity', true); break;
      case 'settings': openSettings(); break;
      case 'stop': stopTurn(); break;
      default: addMsg('model', 'Unknown command `/`' + cmd + '`. Type `/help` for the full list.');
    }
  }

  /* ---------- '/' + '@file' suggestion popover ---------- */
  const SG = { tok: null, items: [], sel: 0 };
  function currentToken(v, caret) {
    const before = v.slice(0, caret);
    if (v[0] === '/' && /^\/[^\s]*$/.test(before)) return { type: 'slash', q: before.slice(1), start: 0 };
    const at = before.lastIndexOf('@');
    if (at >= 0 && /^@[^\s]*$/.test(before.slice(at))) return { type: 'file', q: before.slice(at + 1), start: at };
    return null;
  }
  function projectFiles() { return (S.PROJ && S.PROJ.files) || []; }
  function hideSuggest() { els.suggest.hidden = true; els.suggest.innerHTML = ''; SG.items = []; SG.tok = null; SG.sel = 0; }
  function showSuggest(tok, items) {
    SG.tok = tok; SG.items = items; SG.sel = 0;
    const group = tok.type === 'slash' ? 'Commands' : 'Files in your project';
    const head = '<div class="sg-group">' + esc(group) + '</div>';
    const rows = items.map((it, i) => `<div class="sg-item${i === 0 ? ' sel' : ''}" data-i="${i}"><i data-lucide="${esc(it.icon)}"></i><span class="sg-k">${esc(it.k)}</span><span class="sg-d">${esc(it.desc || '')}</span></div>`).join('');
    els.suggest.innerHTML = head + rows;
    els.suggest.hidden = false;
    try { lucide.createIcons(); } catch (e) {}
  }
  function handleInputSuggestions() {
    const v = els.input.value;
    const caret = els.input.selectionEnd == null ? v.length : els.input.selectionEnd;
    const tok = currentToken(v, caret);
    if (!tok) return hideSuggest();
    const q = tok.q.toLowerCase();
    let items = [];
    if (tok.type === 'slash') {
      items = SLASH.filter(s => !q || s.cmd.startsWith(q)).slice(0, 12)
        .map(s => ({ kind: 'slash', k: '/' + s.cmd, icon: s.icon, desc: s.desc, label: s.cmd }));
    } else {
      const files = projectFiles();
      for (const f of files) {
        if (!q || String(f.rel).toLowerCase().includes(q)) {
          items.push({ kind: 'file', k: '@' + f.rel, icon: 'file-code-2', desc: f.rel, label: f.rel });
          if (items.length >= 14) break;
        }
      }
    }
    if (!items.length) return hideSuggest();
    showSuggest(tok, items);
  }
  function moveSel() {
    els.suggest.querySelectorAll('.sg-item').forEach(n => n.classList.toggle('sel', +n.dataset.i === SG.sel));
    const s = els.suggest.querySelector('.sg-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function acceptSuggest(i) {
    const it = SG.items[i]; if (!it || !SG.tok) return;
    const v = els.input.value;
    const caret = els.input.selectionEnd == null ? v.length : els.input.selectionEnd;
    const start = SG.tok.start;
    const insert = (it.kind === 'slash' ? '/' : '@') + it.label + ' ';
    const nv = v.slice(0, start) + insert + v.slice(caret);
    els.input.value = nv;
    const nc = (start + insert).length;
    try { els.input.setSelectionRange(nc, nc); } catch (e) {}
    autosize(); hideSuggest(); els.input.focus();
  }
  function handleSuggestKeys(e) {
    if (els.suggest.hidden || !SG.items.length) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); SG.sel = clamp(SG.sel + 1, 0, SG.items.length - 1); moveSel(); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); SG.sel = clamp(SG.sel - 1, 0, SG.items.length - 1); moveSel(); return true; }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acceptSuggest(SG.sel); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return true; }
    return false;
  }
  els.suggest.addEventListener('mousedown', e => e.preventDefault());
  els.suggest.addEventListener('click', e => { const n = e.target.closest('.sg-item'); if (n) acceptSuggest(+n.dataset.i); });
  els.input.addEventListener('click', () => { if (!els.suggest.hidden) handleInputSuggestions(); });
  els.input.addEventListener('blur', () => { setTimeout(hideSuggest, 140); });

  /* ---------- voice input (Web Speech) ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null, voiceTarget = null;
  function startVoice(inputEl, btnEl) {
    inputEl = inputEl || els.input; btnEl = btnEl || els.mic;
    if (!SR) { toast('Dictate', 'Voice input needs Chrome / Edge'); return; }
    if (S.recognising) return stopVoice();
    voiceTarget = { input: inputEl, btn: btnEl };
    try {
      recog = new SR();
      recog.lang = 'en-US'; recog.interimResults = true; recog.continuous = false; recog.maxAlternatives = 1;
      const start = inputEl.value;
      const spacer = start && !/\s$/.test(start) ? ' ' : '';
      btnEl.classList.add('listening'); S.recognising = true;
      recog.onresult = ev => { let t = ''; for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; inputEl.value = start + spacer + t; if (inputEl === els.input) autosize(); };
      recog.onerror = ev => { if (ev.error === 'not-allowed') toast('Dictate', 'Microphone permission denied'); stopVoice(); };
      recog.onend = () => stopVoice();
      recog.start();
      try { inputEl.focus(); } catch (e) {}
    } catch (e) { stopVoice(); }
  }
  function stopVoice() {
    S.recognising = false;
    try { els.mic && els.mic.classList.remove('listening'); } catch (e) {}
    try { if (voiceTarget && voiceTarget.btn) voiceTarget.btn.classList.remove('listening'); } catch (e) {}
    voiceTarget = null;
    try { if (recog) { recog.onend = null; recog.abort(); } } catch (e) {}
    recog = null;
  }
  els.mic.onclick = () => { S.recognising ? stopVoice() : startVoice(els.input, els.mic); };
  if (!SR) els.mic.title = 'Dictate — not supported in this browser';

  /* ---------- text-to-speech ---------- */
  function paintTts() {
    els.ttsBtn.setAttribute('aria-pressed', S.tts ? 'true' : 'false');
    els.ttsBtn.title = S.tts ? 'Voice replies ON' : 'Voice replies OFF';
    paintBtnIcon(els.ttsBtn, S.tts ? 'volume-2' : 'volume-x');
  }
  function toggleTts() {
    S.tts = !S.tts; ls('majin_tts', S.tts ? '1' : '0'); paintTts();
    if (!S.tts) { try { speechSynthesis.cancel(); } catch (e) {} }
    toast('Voice', S.tts ? 'Replies will be spoken aloud' : 'Voice replies off');
  }
  function speak(text) {
    if (!S.tts || !text || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const clean = String(text).replace(/```[\s\S]*?```/g, ' Code block. ')
        .replace(/`([^`]+)`/g, '$1').replace(/^[#\s>|*]+/gm, '').replace(/[#*_>|]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (!clean) return;
      const u = new SpeechSynthesisUtterance(clean);
      u.rate = 1.03; u.pitch = 1;
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  els.ttsBtn.onclick = toggleTts;
  els.themeBtn.onclick = cycleTheme;

  /* ---------- independent window ---------- */
  function newChatWindow() { try { window.open(location.href, '_blank', 'noopener'); } catch (e) {} }
  els.newWindow.onclick = newChatWindow;

  /* ==================== PROJECT MAP  (/api/scan + /api/file) ==================== */
  async function scanProject(p) {
    p = (p == null ? els.scanPath.value : String(p)).trim();
    if (!p) { toast('Project', 'Type a folder path first'); return; }
    els.scanPath.value = p; S.PROJ.scanPath = p;
    els.projectBody.innerHTML = '<div class="empty-state"><div class="empty-ic"><i data-lucide="loader-2" class="spin"></i></div><h2>Scanning…</h2><p>Mapping modules and dependencies in ' + esc(cut(p, 60)) + '.</p></div>';
    try { lucide.createIcons(); } catch (e) {}
    try {
      const r = await fetch('/api/scan?path=' + encodeURIComponent(p));
      const j = await r.json();
      if (!r.ok || j.error) { els.projectBody.innerHTML = emptyHtml('folder-x', 'Scan failed', j.error || ('Could not scan (' + r.status + ')')); lucide.createIcons(); toast('Project', j.error || 'Scan failed'); return; }
      renderProject(j);
    } catch (e) { els.projectBody.innerHTML = emptyHtml('folder-x', 'Scan failed', e.message || 'Network error'); lucide.createIcons(); }
  }
  function renderProject(j) {
    S.PROJ.root = j.root; S.PROJ.name = j.name; S.PROJ.modules = j.modules || []; S.PROJ.edges = j.edges || [];
    S.PROJ.stats = j.stats || {}; S.PROJ.warnings = j.warnings || []; S.PROJ._last = j;
    const files = [];
    for (const m of S.PROJ.modules) for (const f of (m.files || [])) files.push({ rel: f, full: joinPath(j.root, f), mod: m.name });
    S.PROJ.files = files;

    const mods = S.PROJ.modules.slice().sort((a, b) => (b.loc || 0) - (a.loc || 0));
    const maxLoc = mods.reduce((t, m) => Math.max(t, m.loc || 0), 1);
    const stats = j.stats || {};
    const warn = (S.PROJ.warnings || []).concat(stats.skippedBig ? [stats.skippedBig + ' very large file(s) were skipped'] : []);

    let html = '';
    html += '<div class="proj-head"><h3>' + esc(j.name || 'Project') + '</h3><span class="proj-path" title="' + esc(j.root) + '">' + esc(j.root) + '</span></div>';
    for (const w of warn) html += '<div class="proj-warn"><i data-lucide="alert-triangle"></i><span>' + esc(w) + '</span></div>';
    html += '<div class="proj-stats">' +
      statCard(S.PROJ.modules.length, 'Modules') +
      statCard(stats.files || files.length || 0, 'Files') +
      statCard((stats.loc || 0).toLocaleString(), 'Lines') +
      statCard((stats.externals || []).length, 'Ext deps') +
      '</div>';

    html += '<div class="sec-label">Modules — click to read a file</div><div class="mod-list">';
    for (const m of mods.slice(0, 24)) {
      const pct = clamp(Math.round(((m.loc || 0) / maxLoc) * 100), 3, 100);
      const target = (m.entry && m.entry[0]) || (m.files && m.files[0]) || '';
      html += '<div class="mod-row" data-rel="' + esc(target) + '" title="' + esc((m.files || []).length) + ' file(s)">' +
        '<span class="mod-name">' + esc(m.name) + '</span>' +
        '<span class="mod-loc">' + (m.loc || 0).toLocaleString() + ' L</span>' +
        '<span class="mod-deps"><b>' + (m.importedBy || 0) + '</b>↓ <b>' + (m.importsOut || 0) + '</b>↑</span>' +
        '<span class="mod-bar"><i style="width:' + pct + '%"></i></span></div>';
    }
    if (!mods.length) html += '<span class="muted">No modules found.</span>';
    html += '</div>';

    if ((stats.externals || []).length) {
      html += '<div class="sec-label">External dependencies</div><div class="ext-chips">';
      for (const e of stats.externals) html += '<span class="ext-chip">' + esc(e.name) + ' <b>' + e.count + '</b></span>';
      html += '</div>';
    }

    els.projectBody.innerHTML = html;
    try { lucide.createIcons(); } catch (e) {}
    els.projectBody.querySelectorAll('.mod-row').forEach(row => {
      row.onclick = () => { const rel = row.dataset.rel; if (!rel) return; openFilePreview(joinPath(S.PROJ.root, rel), rel); };
    });
  }
  function statCard(v, label) { return '<div class="proj-stat"><div class="v">' + esc(String(v)) + '</div><div class="l">' + esc(label) + '</div></div>'; }

  async function openFilePreview(abs, rel) {
    try {
      const r = await fetch('/api/file?path=' + encodeURIComponent(abs));
      const j = await r.json();
      if (!r.ok || j.error) { toast('File', j.error || ('Cannot open (' + r.status + ')')); return; }
      renderFileView(j);
    } catch (e) { toast('File', e.message || 'Could not open file'); }
  }
  function renderFileView(f) {
    const lines = String(f.content || '').split('\n');
    const body = lines.map((ln, i) => '<span class="ln">' + (i + 1) + '</span>' + (esc(ln) || ' ')).join('\n');
    els.projectBody.innerHTML =
      '<div class="file-view-head"><button class="chip-btn" id="fvBack"><i data-lucide="arrow-left"></i><span>Map</span></button>' +
      '<span class="fv-name">' + esc(f.name || bn(f.path)) + '</span>' +
      '<span class="fv-meta">' + (f.loc || lines.length) + ' lines' + (f.truncated ? ' · truncated' : '') + '</span></div>' +
      '<div class="file-view"><pre>' + body + '</pre></div>';
    try { lucide.createIcons(); } catch (e) {}
    const bk = $('fvBack'); if (bk) bk.onclick = () => renderProject(S.PROJ._last);
    els.projectBody.scrollTop = 0;
  }
  els.scanGo.onclick = () => scanProject();
  els.scanPath.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); scanProject(); } });

  /* ==================== READER  (/api/extract) ==================== */
  async function readLink(url) {
    url = (url == null ? els.readUrl.value : String(url)).trim();
    if (!url) { toast('Reader', 'Paste a link first'); return; }
    if (!/^https?:\/\//i.test(url)) { url = 'https://' + url; els.readUrl.value = url; }
    if (S.readerBlobUrl) { try { URL.revokeObjectURL(S.readerBlobUrl); } catch (e) {} S.readerBlobUrl = null; }
    els.readerBody.innerHTML = '<div class="empty-state"><div class="empty-ic"><i data-lucide="loader-2" class="spin"></i></div><h2>Reading…</h2><p>Fetching ' + esc(cut(host(url) || url, 60)) + '.</p></div>';
    try { lucide.createIcons(); } catch (e) {}
    try {
      const r = await fetch('/api/extract?url=' + encodeURIComponent(url));
      const j = await r.json();
      if (!r.ok || j.error) { els.readerBody.innerHTML = emptyHtml('unlink', 'Could not read', j.error || ('Request failed (' + r.status + ')')); lucide.createIcons(); return; }
      if (j.kind === 'pdf') renderPdfDoc(j, url); else renderTextDoc(j, url);
      S.readerUrl = url;
    } catch (e) { els.readerBody.innerHTML = emptyHtml('unlink', 'Could not read', e.message || 'Network error'); lucide.createIcons(); }
  }
  function askAbout(url) { els.input.value = 'Summarise the key points of this page and note anything surprising: ' + url; autosize(); els.input.focus(); }
  function renderTextDoc(j, url) {
    els.readerBody.innerHTML =
      '<div class="reader-doc"><div class="reader-title">' + esc(j.title || j.name || 'Document') + '</div>' +
      '<div class="reader-src">' + esc((j.source ? j.source + ' · ' : '') + host(url)) + (j.truncated ? ' · truncated' : '') + '</div>' +
      '<div class="reader-text">' + esc(j.text || '') + '</div>' +
      '<div class="reader-actions">' +
      '<button class="chip-btn primary" data-r="ask"><i data-lucide="message-square"></i><span>Ask about this</span></button>' +
      '<button class="chip-btn" data-r="copy"><i data-lucide="copy"></i><span>Copy text</span></button>' +
      '<a class="chip-btn" href="' + safeUrl(url) + '" target="_blank" rel="noopener"><i data-lucide="external-link"></i><span>Open source</span></a>' +
      '</div></div>';
    try { lucide.createIcons(); } catch (e) {}
    const ask = els.readerBody.querySelector('[data-r="ask"]'); if (ask) ask.onclick = () => askAbout(url);
    const cp = els.readerBody.querySelector('[data-r="copy"]'); if (cp) cp.onclick = () => copyText(j.text || '', cp);
    els.readerBody.scrollTop = 0;
  }
  function renderPdfDoc(j, url) {
    let u = '';
    try {
      const bin = atob(String(j.data || '')); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: j.mime || 'application/pdf' }); u = URL.createObjectURL(blob); S.readerBlobUrl = u;
    } catch (e) {}
    els.readerBody.innerHTML =
      '<div class="reader-doc"><div class="reader-title">' + esc(j.name || 'PDF document') + '</div>' +
      '<div class="reader-src">' + esc(host(url)) + (j.size ? ' · ' + fmtBytes(j.size) : '') + '</div>' +
      (u ? '<iframe class="reader-pdf" src="' + u + '" title="PDF preview"></iframe>' : '') +
      '<div class="reader-actions">' +
      (u ? '<a class="chip-btn primary" href="' + u + '" target="_blank" rel="noopener"><i data-lucide="eye"></i><span>Open PDF</span></a>' +
        '<a class="chip-btn" href="' + u + '" download="' + esc(j.name || 'document.pdf') + '"><i data-lucide="download"></i><span>Download</span></a>' : '') +
      '<a class="chip-btn" href="' + safeUrl(url) + '" target="_blank" rel="noopener"><i data-lucide="external-link"></i><span>Source</span></a>' +
      '</div></div>';
    try { lucide.createIcons(); } catch (e) {}
    els.readerBody.scrollTop = 0;
  }
  els.readGo.onclick = () => readLink();
  els.readUrl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); readLink(); } });

  /* ==================== MEMORY ==================== */
  function renderMemoryStats() {
    const c = S.memc || {};
    els.memoryStats.innerHTML =
      memRow('scan-search', 'Semantic index', (c.index || 0) ? (c.index + ' folder(s) indexed') : 'Not indexed yet') +
      memRow('search', 'Memory searches', String(c.search || 0)) +
      memRow('sparkles', 'Index status', (c.index || 0) ? 'Available to Majin' : 'Ask Majin to index a folder') +
      memRow('eraser', 'Forgets', String(c.forget || 0));
    try { lucide.createIcons(); } catch (e) {}
  }
  function memRow(icon, label, value) {
    return '<div class="rem-item"><i data-lucide="' + esc(icon) + '"></i><span class="rt">' + esc(label) + '</span><span class="when">' + esc(value) + '</span></div>';
  }
  function addMemoryHit(src, text) {
    if (!text) return;
    const d = document.createElement('div'); d.className = 'mem-hit';
    d.innerHTML = '<div class="mh-src">' + esc(src || 'memory') + '</div><div class="mh-txt">' + esc(cut(text, 240)) + '</div>';
    els.memoryHits.prepend(d);
    while (els.memoryHits.children.length > 12) els.memoryHits.removeChild(els.memoryHits.lastChild);
  }
  function maybeRememberHit(ev) {
    if (ev && ev.name === 'memory_search' && ev.ok !== false && ev.preview) {
      const ph = els.memoryHits.querySelector('.muted'); if (ph) ph.remove();
      addMemoryHit('memory_search', String(ev.preview).replace(/\s+/g, ' ').trim());
    }
  }

  /* ---------- reminders (mirrored from the server's broadcast) ---------- */
  const REM_KEY = 'majin_reminders_v1';
  function getReminders() { try { const a = JSON.parse(lsGet(REM_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function setReminders(list) { ls(REM_KEY, JSON.stringify((list || []).slice(0, 200))); }
  function renderReminders() {
    const list = getReminders();
    if (!list.length) { els.reminderList.innerHTML = '<span class="muted">No reminders yet. Ask Majin to remind you about something.</span>'; return; }
    els.reminderList.innerHTML = list.slice(0, 40).map(r =>
      '<div class="rem-item"><i data-lucide="clock"></i><span class="rt">' + esc(cut(r.text, 140)) + '</span><span class="when">' + esc(timeAgo(r.at || nowMs())) + '</span></div>'
    ).join('');
    try { lucide.createIcons(); } catch (e) {}
  }
  function handleReminderEvent(ev) {
    const text = ev.text || ev.reminder || '';
    if (!text) return;
    const list = getReminders();
    list.unshift({ text: String(text), at: nowMs(), done: false });
    setReminders(list); renderReminders();
    toast('Reminder', cut(String(text), 80));
    celebrate();
  }

  /* ==================== CONVERSATION THREADS ==================== */
  const THREAD_KEY = 'majin_threads_v1', ACTIVE_KEY = 'majin_active';
  const wsCol = $('wsCol');
  const WELCOME = "Hi — I'm **Majin**, your local assistant. I can explain and build code, and *act* on this machine: run commands, manage files, capture the screen, search the web, read pages & PDFs, and map a repo.\n\nAsk me something, hit **/** for commands, or point me at a folder with **@** once you've scanned it in the Project tab.";
  function slimForSave(h) {
    return (h || []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content && !m.tool_calls && !m.tool_results)
      .map(m => ({ role: m.role, content: m.content }));
  }
  function mkThread() {
    return { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: 'New chat', cwd: '', pinned: false, created: nowMs(), updated: nowMs(), history: [], draft: '' };
  }
  function curThread() { return S.active || null; }
  function loadThreads() {
    let arr = []; try { arr = JSON.parse(lsGet(THREAD_KEY) || '[]'); } catch (e) {}
    S.threads = Array.isArray(arr) ? arr.filter(t => t && t.id) : [];
    const a = lsGet(ACTIVE_KEY);
    S.active = S.threads.find(t => t.id === a) || S.threads[0] || null;
  }
  function saveThreads() { try { ls(THREAD_KEY, JSON.stringify(S.threads.slice(0, 80))); ls(ACTIVE_KEY, (S.active && S.active.id) || ''); } catch (e) {} }
  function persistActiveHistory() { const t = curThread(); if (t) { t.history = slimForSave(S.history); t.updated = nowMs(); saveThreads(); } }
  function saveActive() { const t = curThread(); if (t) { t.history = slimForSave(S.history); t.updated = nowMs(); saveThreads(); renderThreadList(els.convSearch.value); updateStatusbarThread(); } }
  function saveDraft() { const t = curThread(); if (t) { t.draft = els.input.value; saveThreads(); } }
  function updateStatusbarThread() { const t = curThread(); els.sbThread.textContent = (t && t.title) || 'New chat'; }

  function renderThreadList(q) {
    q = (q || '').toLowerCase();
    const list = (S.threads || []).slice().filter(t => {
      if (!q) return true;
      if ((t.title || '').toLowerCase().includes(q)) return true;
      return (t.history || []).some(m => m && m.content && m.content.toLowerCase().includes(q));
    }).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
    if (!list.length) { els.threadList.innerHTML = '<div class="rail-empty">' + (S.threads.length ? 'No conversations match that search.' : 'No conversations yet — start one.') + '</div>'; return; }
    els.threadList.innerHTML = list.map(t => {
      const n = (t.history || []).length;
      const sub = (n ? n + ' msg' + (n > 1 ? 's' : '') + ' · ' : '') + timeAgo(t.updated || t.created || nowMs());
      return '<div class="thread-item' + (S.active && t.id === S.active.id ? ' active' : '') + (t.pinned ? ' pinned' : '') + '" data-id="' + esc(t.id) + '">' +
        '<div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px">' +
        '<button class="ti-name" title="' + esc(t.title || 'New chat') + '">' + esc(t.title || 'New chat') + '</button>' +
        '<span class="ti-sub">' + esc(sub) + '</span></div>' +
        '<button class="ti-btn ti-pin" title="' + (t.pinned ? 'Unpin' : 'Pin') + '"><i data-lucide="' + (t.pinned ? 'pin-off' : 'pin') + '"></i></button>' +
        '<button class="ti-btn ti-del" title="Delete"><i data-lucide="trash-2"></i></button></div>';
    }).join('');
    try { lucide.createIcons(); } catch (e) {}
    els.threadList.querySelectorAll('.thread-item').forEach(row => {
      const id = row.dataset.id;
      row.querySelector('.ti-name').onclick = () => switchThread(id);
      row.querySelector('.ti-pin').onclick = e => { e.stopPropagation(); togglePin(id); };
      row.querySelector('.ti-del').onclick = e => { e.stopPropagation(); deleteThread(id); };
    });
  }

  function renderThreadFromHistory() {
    for (const m of S.history) { if (m && m.content) addMsg(m.role === 'user' ? 'user' : 'model', m.content); }
    if (!els.msgs.children.length) greet();
    scrollToBottom(true);
  }
  function greet() { if (!els.msgs.querySelector('.msg.model')) addMsg('model', WELCOME); }

  function applyActiveToUI() {
    updateStatusbarThread(); refreshCwdChip(); refreshModelChip(); renderTray();
    renderThreadList(els.convSearch.value);
  }

  function switchThread(id) {
    if (S.busy) { toast('Busy', 'Wait for the current reply to finish'); return; }
    const t = S.threads.find(x => x.id === id); if (!t) return;
    if (S.active && t.id === S.active.id) return;
    persistActiveHistory();
    S.active = t;
    S.history = (t.history || []).slice();
    els.msgs.innerHTML = '';
    renderThreadFromHistory();
    els.input.value = t.draft || ''; autosize();
    clearAttach();
    applyActiveToUI();
    saveThreads();
    if (window.matchMedia && window.matchMedia('(max-width:560px)').matches) els.shell.classList.remove('rail-open');
    els.input.focus();
  }
  function resetCanvas() { els.blocks.innerHTML = ''; S.blocks = 0; if (els.wsTitle) els.wsTitle.hidden = true; if (els.emptyCanvas) els.emptyCanvas.hidden = false; }
  function newThread() {
    if (S.busy) { toast('Busy', 'Stop the current reply first'); return; }
    persistActiveHistory();
    const t = mkThread(); S.threads.unshift(t); S.active = t;
    S.history = []; els.msgs.innerHTML = ''; els.input.value = ''; autosize();
    clearAttach(); resetCanvas(); greet();
    applyActiveToUI(); saveThreads(); renderThreadList(els.convSearch.value);
    els.input.focus();
  }
  function renameThread(id) {
    const t = S.threads.find(x => x.id === id); if (!t) return;
    const nv = window.prompt('Rename conversation', t.title || 'New chat');
    if (nv == null) return; t.title = cut(String(nv).trim() || 'New chat', 60); saveThreads(); renderThreadList(els.convSearch.value); updateStatusbarThread();
  }
  function togglePin(id) { const t = S.threads.find(x => x.id === id); if (!t) return; t.pinned = !t.pinned; saveThreads(); renderThreadList(els.convSearch.value); }
  function deleteThread(id) {
    const idx = S.threads.findIndex(x => x.id === id); if (idx < 0) return;
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
    const wasActive = S.active && S.active.id === id;
    S.threads.splice(idx, 1);
    if (wasActive) {
      if (!S.threads.length) S.threads.push(mkThread());
      S.active = S.threads[0] || null;
      S.history = (S.active && S.active.history || []).slice();
      els.msgs.innerHTML = ''; renderThreadFromHistory(); applyActiveToUI();
    }
    saveThreads(); renderThreadList(els.convSearch.value);
  }

  function bootThreadUI() {
    loadThreads();
    if (!S.threads.length) S.threads.push(mkThread());
    if (!S.active) S.active = S.threads[0] || null;
    S.history = (S.active && S.active.history || []).slice();
    els.msgs.innerHTML = ''; renderThreadFromHistory();
    if (S.active && S.active.draft) { els.input.value = S.active.draft; autosize(); }
    applyActiveToUI();
  }

  els.newThread.onclick = newThread;
  els.convSearch.addEventListener('input', e => renderThreadList(e.target.value));
  els.exportBtn.onclick = exportActive;

  /* ==================== EXPORT ==================== */
  function exportActive() {
    const msgs = slimForSave(S.history);
    if (!msgs.length) { toast('Export', 'Nothing to export yet'); return; }
    const t = curThread(); const title = (t && t.title) || 'Majin chat';
    let md = '# ' + title + '\n\n_Exported from Majin · ' + new Date().toLocaleString() + '_\n\n';
    for (const m of msgs) md += (m.role === 'user' ? '**You:** ' : '**Majin:** ') + '\n\n' + m.content + '\n\n';
    try {
      const blob = new Blob([md], { type: 'text/markdown' }); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = (bn(title).replace(/[^\w-]+/g, '_').slice(0, 48) || 'majin-chat') + '.md';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Export', 'Saved as Markdown');
    } catch (e) { toast('Export', 'Could not build the file'); }
  }

  /* ==================== SNIPPETS ==================== */
  const SNIP_KEY = 'majin_snippets_v1';
  function getSnippets() { try { const a = JSON.parse(lsGet(SNIP_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function setSnippets(l) { ls(SNIP_KEY, JSON.stringify((l || []).slice(0, 100))); }
  function renderSnippets() {
    const l = getSnippets();
    if (!l.length) { els.snippetsList.innerHTML = '<div class="snip-empty">No saved snippets yet. Compose a prompt, then “Save current prompt”.</div>'; return; }
    els.snippetsList.innerHTML = l.map((s, i) =>
      '<div class="snippet-item"><div class="sn-t">' + esc(s.title || 'Snippet') + '</div><div class="sn-b">' + esc(s.body || '') + '</div>' +
      '<div class="sn-a"><button data-use="' + i + '">Insert</button><button class="sn-del" data-del="' + i + '">Delete</button></div></div>'
    ).join('');
  }
  function openSnippets() { renderSnippets(); els.snippetsDrawer.hidden = false; }
  function closeSnippets() { els.snippetsDrawer.hidden = true; }
  function insertSnippet(i) { const s = getSnippets()[i]; if (!s) return; els.input.value = s.body || ''; autosize(); closeSnippets(); els.input.focus(); }
  function delSnippet(i) { const l = getSnippets(); l.splice(i, 1); setSnippets(l); renderSnippets(); }
  function addSnippet() {
    const body = (els.input.value || '').trim();
    if (!body) { toast('Snippets', 'Type a prompt to save first'); return; }
    let title = null; try { title = window.prompt('Name this snippet', cut(body, 40)); } catch (e) {}
    const l = getSnippets(); l.unshift({ title: String(title || cut(body, 40)).slice(0, 60), body }); setSnippets(l); renderSnippets(); toast('Snippets', 'Saved');
  }
  els.snippetsBtn.onclick = openSnippets;
  els.snippetsClose.onclick = closeSnippets;
  els.addSnippet.onclick = addSnippet;
  els.snippetsDrawer.addEventListener('click', e => { if (e.target === els.snippetsDrawer) closeSnippets(); });
  els.snippetsList.addEventListener('click', e => {
    const u = e.target.closest('[data-use]'); if (u) return insertSnippet(+u.dataset.use);
    const d = e.target.closest('[data-del]'); if (d) return delSnippet(+d.dataset.del);
  });

  /* ==================== RAIL + WORKSPACE RESIZE ==================== */
  function toggleRail() {
    const narrow = window.matchMedia && window.matchMedia('(max-width:560px)').matches;
    if (narrow) els.shell.classList.toggle('rail-open');
    else els.rail.classList.toggle('collapsed');
  }
  els.railToggle.onclick = toggleRail;

  function applyWsWidth() { const w = lsGet('majin_ws'); if (w && wsCol) wsCol.style.setProperty('--ws-w', w); }
  function setupSplitter(sp, target, min, max, key) {
    if (!sp || !target) return;
    let dragging = false;
    sp.addEventListener('mousedown', e => {
      if (window.matchMedia && window.matchMedia('(max-width:860px)').matches) return;
      dragging = true; e.preventDefault(); document.body.style.userSelect = 'none'; sp.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const rect = els.shell.getBoundingClientRect();
      const pct = clamp(((rect.right - e.clientX) / rect.width) * 100, min, max);
      target.style.setProperty('--ws-w', pct.toFixed(1) + '%');
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return; dragging = false; document.body.style.userSelect = ''; sp.classList.remove('dragging');
      ls(key, target.style.getPropertyValue('--ws-w') || '');
    });
  }

  /* ==================== COMMAND PALETTE ==================== */
  function paletteItems() {
    const acts = [
      { label: 'New conversation', icon: 'plus', hint: 'Ctrl+⇧+N', run: newThread },
      { label: 'Scan a project folder', icon: 'radar', hint: 'Project', run: () => { setTab('project', true); els.scanPath.focus(); } },
      { label: 'Read a link, PDF or video', icon: 'globe', hint: 'Reader', run: () => { setTab('reader', true); els.readUrl.focus(); } },
      { label: 'Open the floating Vision pill', icon: 'monitor', hint: 'Vision', run: openVisionOverlay },
      { label: 'Open Memory', icon: 'brain', hint: 'Tab', run: () => setTab('memory', true) },
      { label: 'Open Activity log', icon: 'activity', hint: 'Tab', run: () => setTab('activity', true) },
      { label: 'Cycle theme (system → light → dark)', icon: 'moon', run: cycleTheme },
      { label: S.autoApprove ? 'Turn auto-approve off' : 'Turn auto-approve on', icon: 'shield', run: () => els.autoBtn.click() },
      { label: S.tts ? 'Voice replies: off' : 'Voice replies: on', icon: 'volume-2', run: toggleTts },
      { label: 'Settings — provider, model & keys', icon: 'settings', hint: 'Enter', run: openSettings },
      { label: 'Export this conversation (.md)', icon: 'download', run: exportActive },
      { label: 'Saved prompt snippets', icon: 'bookmark', run: openSnippets },
      { label: 'Open a second independent window', icon: 'app-window', hint: 'Ctrl+⇧+O', run: newChatWindow },
    ];
    const convs = (S.threads || []).slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0))
      .slice(0, 10).map(t => ({ label: t.title || 'New chat', icon: 'message-square', hint: 'Jump', run: () => switchThread(t.id) }));
    return acts.concat(convs);
  }
  const PAL = { view: [], sel: 0 };
  function renderPalette(q) {
    q = (q || '').toLowerCase();
    const all = paletteItems();
    PAL.view = all.filter(it => !q || it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q));
    PAL.sel = 0;
    if (!PAL.view.length) { els.paletteList.innerHTML = '<div class="palette-empty">No matches</div>'; return; }
    els.paletteList.innerHTML = PAL.view.map((it, i) =>
      '<div class="palette-item' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '"><span class="pi-ic"><i data-lucide="' + esc(it.icon) + '"></i></span><span class="pi-label">' + esc(it.label) + '</span>' + (it.hint ? '<span class="pi-hint">' + esc(it.hint) + '</span>' : '') + '</div>'
    ).join('');
    try { lucide.createIcons(); } catch (e) {}
  }
  function openPalette() { els.palette.hidden = false; els.paletteInput.value = ''; renderPalette(''); els.paletteInput.focus(); }
  function closePalette() { els.palette.hidden = true; }
  function palMove(d) {
    if (!PAL.view.length) return;
    PAL.sel = clamp(PAL.sel + d, 0, PAL.view.length - 1);
    els.paletteList.querySelectorAll('.palette-item').forEach(n => n.classList.toggle('sel', +n.dataset.i === PAL.sel));
    const s = els.paletteList.querySelector('.palette-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function palRun(i) { const it = PAL.view[i == null ? PAL.sel : i]; if (!it) return; closePalette(); try { it.run(); } catch (e) {} }
  els.paletteBtn.onclick = openPalette;
  els.palette.addEventListener('click', e => { if (e.target === els.palette) return closePalette(); const n = e.target.closest('.palette-item'); if (n) palRun(+n.dataset.i); });
  els.paletteInput.addEventListener('input', e => renderPalette(e.target.value));
  els.paletteInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); palRun(); }
  });

  /* ==================== GLOBAL KEYBOARD ==================== */
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (!els.confirmModal.hidden) {
      if (e.key === 'Enter') { e.preventDefault(); resolveConfirm(true); }
      else if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(false); }
      return;
    }
    if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); els.palette.hidden ? openPalette() : closePalette(); return; }
    if (mod && e.key === ']') { e.preventDefault(); toggleRail(); return; }
    if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); newChatWindow(); return; }
    if (mod && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newThread(); return; }
    if (e.key === 'Escape') {
      if (!els.suggest.hidden) return hideSuggest();
      if (els.modelPop && !els.modelPop.hidden) return toggleModelPop(false);
      if (!els.palette.hidden) return closePalette();
      if (!els.snippetsDrawer.hidden) return closeSnippets();
      if (!els.settingsModal.hidden) return closeSettings();
      if (!els.lightbox.hidden) return closeLight();
      if (els.shell.classList.contains('ws-open')) return closeWsOverlay();
      if (els.shell.classList.contains('rail-open')) return els.shell.classList.remove('rail-open');
      if (S.busy) stopTurn();
    }
  });

  /* ==================== HINT CHIPS (welcome) ==================== */
  const HINTS = [
    'Explain how this repo is structured — scan a folder first, then summarise its modules',
    'Write a Python script to rename every file in a folder by its modified date',
    'Take a screenshot and tell me what is on my screen',
    'Refactor this function into a pure one and add pytest unit tests',
    'Set a reminder to review my pull request tomorrow at 10am',
    'Find in my indexed files where the database connection is configured',
  ];
  function renderHintChips() {
    els.hintChips.innerHTML = HINTS.map(h => '<button class="sample-prompt" type="button">' + esc(cut(h, 72)) + '</button>').join('');
    els.hintChips.querySelectorAll('.sample-prompt').forEach((b, i) => b.onclick = () => { els.input.value = HINTS[i]; autosize(); doSend(); });
  }

  /* ==================== LIVE EVENT CHANNEL ==================== */
  function openEvents() {
    if (!('EventSource' in window)) return;
    try {
      const es = new EventSource('/api/events');
      es.onopen = () => { if (els.sbConn) els.sbConn.textContent = 'localhost · live'; };
      es.onerror = () => { if (els.sbConn) els.sbConn.textContent = 'localhost'; };
      es.onmessage = e => { let ev; try { ev = JSON.parse(e.data); } catch (_) { return; } if (ev && ev.type === 'reminder') handleReminderEvent(ev); };
      S.es = es;
    } catch (e) {}
  }

  /* ==================== BOOT ==================== */
  async function boot() {
    applyTheme(); applyMotion(); paintAutoApprove(); paintTts();
    await ensureToken();
    bootThreadUI();
    renderHintChips();
    await loadConfig();
    fillProviders(); loadModels(S.CFG && S.CFG.model);
    renderMemoryStats(); renderReminders();
    applyWsWidth(); setupSplitter(els.wsSplitter, wsCol, 24, 72, 'majin_ws');
    setTab('canvas');
    checkStatus(); setInterval(checkStatus, 20000);
    openEvents();
    try { lucide.createIcons(); } catch (e) {}
    els.input.focus();
  }

  try { boot(); } catch (e) { console && console.error && console.error('Majin boot failed:', e); }
  window.addEventListener('load', () => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); });
})();

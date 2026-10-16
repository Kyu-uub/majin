/* Majin — server: the assistant host.
   The browser is thin; the model runs HERE so it can use the capability tools in
   tools.js (OS, files, web, screen). /api/agent streams the whole turn over SSE:
   assistant text, every tool call and its result, and — for risky actions — a
   confirmation request the user must approve before anything runs. The client
   simply renders those events.
   Localhost-only: the agent can control this machine, so it binds to loopback. */
import express from 'express';
import dotenv from 'dotenv';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { TOOLS, isDangerous, setBroadcast, startReminderScheduler, workspaceFromTool } from './tools.js';
import { PROVIDERS, PROVIDER_ORDER, providerConfig, openaiBase, callProvider, ProviderError, normalizeHistory, stripImages, listModels } from './providers.js';

/* Config lives in a .env file. In development that sits next to server.js; in a
   packaged app server.js is inside a read-only app.asar, so desktop/main.js points
   MAJIN_CONFIG_DIR at a writable per-user folder (AppData). dotenv loads whatever is
   already there; the settings modal writes keys back to the same place. */
const CONFIG_DIR = String(process.env.MAJIN_CONFIG_DIR || path.dirname(fileURLToPath(import.meta.url))).trim();
const ENV_PATH = path.join(CONFIG_DIR, '.env');
try { mkdirSync(CONFIG_DIR, { recursive: true }); } catch (_) {}
dotenv.config({ path: ENV_PATH });

const app = express();
app.use(express.json({ limit: '24mb' }));

/* ---- localhost guard (the agent runs OS commands; never expose it) ---- */
app.use((req, res, next) => {
    const h = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')) return next();
    res.status(403).json({ error: 'Majin only answers from localhost' });
});

/* ---- CSRF guard: a random per-boot token echoed on every state-changing POST.
   The page fetches it once from /api/boot (same-origin) and sends it back in the
   X-Majin-Token header. A cross-origin page can't read /api/boot (CORS) and can't
   add a custom header on a no-cors form/fetch POST without triggering a preflight
   we never grant — so drive-by requests to these endpoints are rejected. ---- */
const CSRF_TOKEN = crypto.randomBytes(18).toString('hex');
app.post(['/api/agent', '/api/config', '/api/confirm'], (req, res, next) => {
    if (req.headers['x-majin-token'] !== CSRF_TOKEN) {
        return res.status(403).json({ error: 'Missing or invalid Majin session token.' });
    }
    next();
});

/* ---- Content Security Policy + hardening headers (defense in depth vs injected
   markup). Everything the UI needs is served same-origin (public/vendor, compiled
   css) or via data:/blob: (screenshots, inline PDFs); highlight.js compiles regexes
   so it needs unsafe-eval. Scripts cannot be added from elsewhere, no plugins, no
   framing, forms stay local. ---- */
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
app.use(express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
        else if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    }
}));

/* ---- Providers (Gemini + Groq): the agent loop is provider-agnostic ---- */
let liveProvider = (process.env.MAJIN_PROVIDER || 'gemini').trim();
if (!PROVIDERS[liveProvider]) liveProvider = 'gemini';
let liveModel = (process.env.MAJIN_MODEL || '').trim() || null;    // model id for the active provider (or default)

const keyFor = provider => String(process.env[providerConfig(provider).keyEnv] || '').trim();
const currentKey = () => keyFor(liveProvider);
const activeModel = () => liveModel || providerConfig(liveProvider).defaultModel;

// Our tools in the neutral shape both adapters understand.
const TOOL_DEFS = TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
const TOOL_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

// One model turn, streamed. Transient failures (429 / 5xx / timeout) retry with a
// patient backoff that honours the provider's own "wait Ns" hint, and if the active
// provider stays throttled we fail over to the other provider that has a key — so a
// free-tier rate limit degrades gracefully instead of erroring out the turn.
const REQUEST_TIMEOUT = 45000, MAX_ATTEMPTS = 3, MAX_WAIT = 12000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const modelFor = provider => provider === liveProvider ? activeModel() : providerConfig(provider).defaultModel;
async function askModel(messages, signal, emit, hasImages) {
    let lane = [liveProvider, ...PROVIDER_ORDER.filter(p => p !== liveProvider && keyFor(p))];
    // A turn carrying pictures (Vision screen share, or a tool screenshot) must run on a
    // model that can actually see them — prefer Gemini whenever it has a key, otherwise a
    // text-only provider silently degrades the image to "[can't view images]" and acts blind.
    if (hasImages && keyFor('gemini') && liveProvider !== 'gemini') lane = ['gemini', ...lane.filter(p => p !== 'gemini')];
    let lastErr;
    for (let li = 0; li < lane.length; li++) {
        const provider = lane[li], model = modelFor(provider), apiKey = keyFor(provider);
        const label = PROVIDERS[provider].label;
        if (li > 0) { emit({ type: 'reset_text' }); emit({ type: 'notice', text: `${PROVIDERS[liveProvider].label} is busy — switching to ${label}…` }); }
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            let sent = false;
            try {
                const asst = await callProvider({
                    provider, model, apiKey, system: SYSTEM_PROMPT, messages, tools: TOOL_DEFS, signal,
                    timeoutMs: REQUEST_TIMEOUT,
                    onText: t => { sent = true; emit({ type: 'token', text: t }); }
                });
                asst._provider = provider; asst._model = model;              // reported in the done event
                return asst;
            } catch (e) {
                if (e.name === 'AbortError') throw e;                        // user stopped the turn — never retry
                lastErr = e;
                const transient = e instanceof ProviderError && e.transient;
                const rateLimited = e instanceof ProviderError && e.status === 429;
                const isLastLane = li === lane.length - 1;
                if (!transient) break;                                       // hard error: try next lane, don't retry here
                if (attempt === MAX_ATTEMPTS - 1) break;                     // out of tries on this provider: fail over
                if (sent) emit({ type: 'reset_text' });                     // discard partial bubble before retry
                const wait = Math.min(MAX_WAIT, Math.max(600 * 2 ** attempt, (e.retryAfterMs || 0)));
                emit({ type: 'notice', text: rateLimited
                    ? `${label} is rate-limited — waiting ${Math.max(1, Math.round(wait / 1000))}s then retrying (${attempt + 2}/${MAX_ATTEMPTS})${isLastLane ? '' : ', then will try the other provider'}…`
                    : `${label} is congested — retrying (${attempt + 2}/${MAX_ATTEMPTS})…` });
                await sleep(wait);
            }
        }
    }
    throw lastErr;
}

/* ==========================================================================
   /api/agent  (POST) — one assistant turn, streamed as Server-Sent Events.
   Body: { history: [Gemini contents...], message: "...", images?: [b64] }
   Events: token | tool | tool_result | confirm | done | error
   ========================================================================== */
// Pending risky actions wait here until the browser approves or denies them.
const pendingConfirms = new Map();
function waitForConfirm(id, ttlMs) {
    return new Promise(resolve => {
        const t = setTimeout(() => { pendingConfirms.delete(id); resolve(false); }, ttlMs);
        pendingConfirms.set(id, { resolve: ok => { clearTimeout(t); pendingConfirms.delete(id); resolve(!!ok); } });
    });
}
app.post('/api/confirm', (req, res) => {
    const { id, approved } = req.body || {};
    const p = pendingConfirms.get(String(id));
    if (p) p.resolve(!!approved);
    res.json({ ok: !!p });
});
app.get('/api/status', (req, res) => {
    res.json({ provider: liveProvider, hasKey: !!currentKey(), model: activeModel(), vision: (liveProvider === 'gemini' && !!currentKey()) || !!keyFor('gemini'), tools: TOOLS.map(t => t.name) });
});
app.get('/api/boot', (req, res) => res.json({ token: CSRF_TOKEN }));

/* ---- in-app settings: paste the API key, save it into .env (localhost-only) ---- */
function maskKey(k) {
    const s = String(k || '').trim();
    if (!s) return null;
    return s.length <= 8 ? '••••••••' : '••••••••' + s.slice(-4);
}
async function updateEnvFile(values) {
    let text = '';
    try { text = await fs.readFile(ENV_PATH, 'utf8'); } catch (e) { text = ''; }
    const names = Object.keys(values);
    const out = []; const seen = new Set();
    for (const ln of (text.length ? text.split(/\r?\n/) : [])) {
        const m = ln.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[\s\S]*$/);
        if (m && names.includes(m[1])) { out.push(`${m[1]}=${values[m[1]]}`); seen.add(m[1]); }
        else out.push(ln);
    }
    for (const n of names) if (!seen.has(n)) out.push(`${n}=${values[n]}`);
    await fs.writeFile(ENV_PATH, out.join('\n').replace(/\s+$/, '') + '\n', 'utf8');
}
app.get('/api/config', (req, res) => res.json(configSnapshot()));
function configSnapshot() {
    const g = keyFor('gemini'), r = keyFor('groq'), f = keyFor('freellm');
    return {
        provider: liveProvider,
        model: liveModel || providerConfig(liveProvider).defaultModel,
        hasKey: !!currentKey(),
        gemini: { hasKey: !!g, keyMask: maskKey(g) },
        groq: { hasKey: !!r, keyMask: maskKey(r) },
        freellm: { hasKey: !!f, keyMask: maskKey(f), baseUrl: openaiBase('freellm') },
        providers: PROVIDER_ORDER.map(p => ({ id: p, label: PROVIDERS[p].label, defaultModel: PROVIDERS[p].defaultModel }))
    };
}
app.post('/api/config', async (req, res) => {
    const b = req.body || {};
    const envWrites = {};
    try {
        const gk = b.geminiKey !== undefined ? String(b.geminiKey).trim() : '';
        if (gk) { process.env.GEMINI_API_KEY = gk; envWrites.GEMINI_API_KEY = gk; }
        const rk = b.groqKey !== undefined ? String(b.groqKey).trim() : '';
        if (rk) { process.env.GROQ_API_KEY = rk; envWrites.GROQ_API_KEY = rk; }
        const fk = b.freellmKey !== undefined ? String(b.freellmKey).trim() : '';
        if (fk) { process.env.FREELLMAPI_API_KEY = fk; envWrites.FREELLMAPI_API_KEY = fk; }
        if (b.freellmBaseUrl !== undefined) {
            const base = String(b.freellmBaseUrl).trim().replace(/\/+$/, '');
            if (base && !/^https?:\/\//i.test(base)) return res.status(400).json({ error: 'FreeLLMAPI base URL must start with http:// or https://' });
            if (base) { process.env.FREELLMAPI_BASE_URL = base; envWrites.FREELLMAPI_BASE_URL = base; }
        }
        if (b.provider && PROVIDERS[b.provider]) { liveProvider = b.provider; envWrites.MAJIN_PROVIDER = b.provider; }
        const mdl = String(b.model || '').trim();
        liveModel = mdl || providerConfig(liveProvider).defaultModel;   // always a model valid for the active provider
        envWrites.MAJIN_MODEL = liveModel;
        if (Object.keys(envWrites).length) await updateEnvFile(envWrites);
        res.json(configSnapshot());
    } catch (e) {
        res.status(500).json({ error: 'Could not save settings: ' + (e.message || String(e)) });
    }
});

/* Live model list for the settings dropdown. Uses the saved key for that provider. */
app.get('/api/models', async (req, res) => {
    const provider = String(req.query.provider || liveProvider).trim();
    if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Unknown provider' });
    const apiKey = keyFor(provider);
    if (!apiKey) return res.status(400).json({ error: `No ${PROVIDERS[provider].label} key saved yet — add one first.` });
    try { res.json({ provider, models: await listModels(provider, apiKey) }); }
    catch (e) { res.status(e.status || 502).json({ error: e.message || 'Could not list models' }); }
});

/* Persistent event stream. Every window opens this once at boot and keeps it
   alive, so reminders (and any server-raised event) arrive even when that
   window is idle — not only while an agent turn is streaming. */
const eventStreams = new Set();
app.get('/api/events', (req, res) => {
    sseHead(res);
    res.write(': open\n\n');                     // establish the stream so clients fire onopen
    eventStreams.add(res);
    req.on('close', () => eventStreams.delete(res));
});

function sseHead(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
}
function send(res, event) { res.write(`data: ${JSON.stringify(event)}\n\n`); }

/* The live set holds only the windows with a turn in flight — a tool pushes its
   workspace blocks into its own stream via ctx.emit. Reminders and other
   server-raised events go to the persistent eventStreams instead, so they land
   in every open window, even ones that are idle. */
const liveStreams = new Set();
function safeSend(res, event) {
    if (res.writableEnded) { liveStreams.delete(res); return; }
    try { send(res, event); } catch (e) { liveStreams.delete(res); }
}
setBroadcast(evt => { for (const res of [...eventStreams]) { if (res.writableEnded) { eventStreams.delete(res); continue; } try { send(res, evt); } catch (e) { eventStreams.delete(res); } } });

app.post('/api/agent', async (req, res) => {
    sseHead(res);
    const abort = new AbortController();
    let finished = false;
    // This turn talks back to *this* window only — a second window running its own
    // heavy task can no longer have its blocks land in the wrong stream.
    const emit = evt => safeSend(res, evt);
    liveStreams.add(res);
    res.on('close', () => { liveStreams.delete(res); if (!finished) abort.abort(); });   // only a genuine early disconnect
    const endOnce = () => { if (!finished) { finished = true; liveStreams.delete(res); res.end(); } };

    const { history = [], message = '', images = [], screenshot = false } = req.body || {};
    if (!currentKey()) { send(res, { type: 'error', error: `No ${PROVIDERS[liveProvider].label} API key saved yet — open Settings to add one.` }); endOnce(); return; }

    // Normalized conversation: the incoming history (legacy Gemini contents OR
    // stored normalized turns) plus this user message. The adapters render it per
    // provider; the loop below works entirely in this neutral shape.
    const msgs = normalizeHistory(history);
    const userTurn = { role: 'user', content: message };
    const ims = (images || []).slice(0, 4).map(im => ({ mime: im.mime || 'image/png', data: im.data }));
    if (ims.length) userTurn.images = ims;
    msgs.push(userTurn);
    let sawImages = ims.length > 0;

    // Everything appended after the incoming history belongs to this turn; the
    // client stores it back as history so the next turn remembers tool calls and
    // their results. Inline image bytes are stripped to keep history light.
    const historyLen = msgs.length - 1;
    const doneEvent = extra => {
        const lastAsst = [...msgs].reverse().find(m => m && m.role === 'assistant') || {};
        return { type: 'done', provider: lastAsst._provider || liveProvider, model: lastAsst._model || activeModel(), turnContents: msgs.slice(historyLen).map(stripImages), ...extra };
    };

    try {
        // When the turn carries a screenshot (Vision), reinforce the contract server-side:
        // the image IS the live desktop, so look and locate instead of probing with tools.
        if (screenshot && Array.isArray(images) && images.length) {
            msgs.push({ role: 'user', content: '[Vision] The attached image is the user\'s live screen RIGHT NOW. Answer by looking at it. Do NOT call run_command, ocr_screen, screenshot, or file tools to discover what you can already see in the picture. To act, call click / type_text / press_keys using REAL on-screen pixel coordinates read directly from the image.' });
        }

        // The loop: model → maybe tool calls → we run them (with confirm gate) → feed back → repeat.
        for (let step = 0; step < 8; step++) {
            const asst = await askModel(msgs, abort.signal, emit, sawImages);   // streams its own tokens
            msgs.push(asst);
            const toolCalls = asst.tool_calls || [];
            if (!toolCalls.length) { send(res, doneEvent()); endOnce(); return; }

            const results = [];
            const imageTurns = [];
            for (const tc of toolCalls) {
                const name = tc.name;
                // Stable id ties this `tool` event to its `tool_result` so the client can
                // render a per-turn trace even when the same tool is called twice.
                const callId = tc.id || crypto.randomBytes(4).toString('hex');
                const tool = TOOL_BY_NAME.get(name);
                emit({ type: 'tool', id: callId, name, args: tc.args });
                if (!tool) { emit({ type: 'tool_result', id: callId, name, ok: false, error: 'Unknown tool', ms: 0 }); results.push({ id: tc.id, name, response: { error: 'Unknown tool' } }); continue; }

                let outcome;
                if (isDangerous(tool, tc.args)) {
                    const id = crypto.randomBytes(6).toString('hex');
                    emit({ type: 'confirm', id, name, args: tc.args, reason: confirmReason(name, tc.args) });
                    const ok = await waitForConfirm(id, 120000);
                    if (!ok) { outcome = { error: 'The user did not approve this action, so it was not run.' }; emit({ type: 'tool_result', id: callId, name, ok: false, cancelled: true, ms: 0 }); }
                    else outcome = await runTool(tool, tc.args, emit, callId);
                } else {
                    outcome = await runTool(tool, tc.args, emit, callId);
                }

                if (outcome && outcome._image) {   // screenshot: show it, then let the model read it next round
                    emit({ type: 'shot', data: outcome._image });
                    imageTurns.push({ role: 'user', images: [{ mime: 'image/png', data: outcome._image }], content: 'This is the current screenshot.' });
                    delete outcome._image;
                }
                results.push({ id: tc.id, name, response: outcome });
            }
            msgs.push({ role: 'user', tool_results: results });
            for (const it of imageTurns) msgs.push(it);
            if (imageTurns.length) sawImages = true;
        }
        send(res, doneEvent({ note: 'Stopped after 8 tool rounds.' }));
        endOnce();
    } catch (e) {
        console.error('[agent] threw:', e && (e.stack || e.message) || e);
        if (e.name === 'AbortError') return endOnce();
        try { send(res, { type: 'error', error: e.message || String(e) }); } catch (x) {}
        endOnce();
    }
});

async function runTool(tool, args, emit, id) {
    const t0 = Date.now();
    try {
        const result = await tool.run(args, { emit });
        emit({ type: 'tool_result', id, name: tool.name, ok: true, preview: shortPreview(result), ms: Date.now() - t0 });
        try { const ws = workspaceFromTool(tool.name, result); if (ws) emit({ type: 'workspace', title: ws.title, blocks: ws.blocks }); } catch (e) {}
        return result && typeof result === 'object' ? result : { result };
    } catch (e) {
        const err = { error: e.message || String(e) };
        emit({ type: 'tool_result', id, name: tool.name, ok: false, error: e.message || String(e), ms: Date.now() - t0 });
        return err;
    }
}
function shortPreview(r) {
    try {
        if (typeof r === 'string') return r.slice(0, 300);
        if (r && typeof r === 'object') {
            const slim = {};
            for (const [k, v] of Object.entries(r)) {
                if (k === '_image' || k === 'data') { slim[k] = `[${String(v || '').length} chars]`; }
                else if (typeof v === 'string' && v.length > 400) { slim[k] = v.slice(0, 400) + '…'; }
                else slim[k] = v;
            }
            return (JSON.stringify(slim) || '').slice(0, 300);
        }
        return String(r == null ? '' : r).slice(0, 300);
    } catch (e) { return ''; }
}
function confirmReason(name, args) {
    if (name === 'power') return `This will ${args.action} your machine.`;
    if (name === 'open_app') return `Majin will launch ${args.app}${args.args && args.args.length ? ` with: ${args.args.join(' ')}` : ''} on this PC.`;
    if (name === 'install') return `Majin will install ${args.target}${args.kind && args.kind !== 'auto' ? ` via ${args.kind}` : ''} on this PC.`;
    if (name === 'run_command') return 'This runs a shell command that can change or delete things: ' + args.command;
    if (name === 'write_file') return 'This writes outside the safe folders: ' + args.path;
    if (name === 'kill_process') return `Majin will force-stop ${args.pid ? ('process #' + args.pid) : ('all "' + args.name + '" processes')}. Any unsaved work in it will be lost.`;
    if (name === 'manage_files') return args.op === 'delete' ? `Majin will permanently delete ${args.src}. This cannot be undone.` : `Majin will ${args.op}${args.dest ? ' → ' + args.dest : ''} on this PC.`;
    if (name === 'click') return `Majin will click (${args.x}, ${args.y}) on your screen with the ${args.button || 'left'} button${args.double ? ' (double-click)' : ''}.`;
    if (name === 'move_mouse') return `Majin will move your mouse cursor to (${args.x}, ${args.y}).`;
    if (name === 'drag') return `Majin will drag from (${args.from_x}, ${args.from_y}) to (${args.to_x}, ${args.to_y}) — like selecting or moving something on screen.`;
    if (name === 'scroll') return `Majin will scroll ${args.direction || 'down'} by ${args.amount || 3} on your screen.`;
    if (name === 'type_text') return `Majin will type into the focused window: “${String(args.text || '').slice(0, 60)}”. Make sure the right field has focus first.`;
    if (name === 'press_keys') return `Majin will press ${args.combo} (goes to whatever window is focused).`;
    if (name === 'index_files') return `Majin will read text/code files under ${args.path || '~/Documents'} and send those passages to the embedding provider to build memory.`;
    if (name === 'memory_forget') return args.path ? `Majin will remove indexed passages under ${args.path}.` : 'Majin will clear the ENTIRE semantic memory index.';
    return `Majin wants to use ${name}.`;
}

const SYSTEM_PROMPT = `You are Majin, a capable personal assistant running on the user's own Windows PC, in the spirit of JARVIS / E.D.I.T.H.
You are concise, precise and proactive. You can act, not just talk: open apps, browse, run commands, read and write files, organise the file system (move/copy/rename/delete/make folders with manage_files), read or set the clipboard, install apps or libraries, inspect the screen, read on-screen text with OCR (ocr_screen), drive the desktop with Computer Use (screen_info/move_mouse/click/drag/scroll/type_text/press_keys), control media, list and stop processes, list and focus windows, check disk space, search the web (web_search) then open or read a result, manage reminders, analyse a code folder, keep a semantic memory of your files (index_files/memory_search/memory_stats), and present structured material in the Workspace panel.

Rules:
- When a request needs a real action, CALL the tool. Do not pretend you did something without calling it.
- When the user asks to install software or a package/library, USE the install tool (it confirms with them, then runs winget/npm/pip for real) — don't just hand them a command to paste.
- For file organising use manage_files (move/copy/rename/delete/mkdir), for the clipboard use clipboard, for processes use list_processes/kill_process, for windows use list_windows/activate_window, for space use disk_usage, and to find things online use web_search then open_url/read_url — prefer these dedicated tools over raw run_command, because they are jailed and confirmation-gated.
- Computer Use: to read what is on screen use ocr_screen (it gives each line plus a clickable cx/cy) — then click those cx/cy. Call screen_info first for bounds so coordinates stay on-screen. Before type_text/press_keys, use list_windows + activate_window so input lands in the right place, and prefer a specific tool (open_app, click a control, etc.) over a blind keystroke. Every input action is shown to the user for confirmation — do it deliberately, one meaningful step at a time, and verify with ocr_screen or screenshot between steps rather than firing many blind actions.
- Semantic memory: when the user wants you to recall something they wrote/own, run index_files once on the relevant folder (default ~/Documents, it confirms first because it uploads passages), then memory_search for follow-ups. Say that v1 only reads text/code, not PDF/DOCX/images.
- Chain tools when useful (e.g. screenshot then read what is on screen; scan_repo then summarise it).
- The Workspace (right panel) is your default canvas. Reach for show_blocks on your own — for dashboards, summaries, comparisons, plans, guides, or any structured/visual content — instead of dumping long chat paragraphs. Rich widgets: hero, metrics (count-up stats), progress (animated bars), timeline, chips, table, keyvalue, list, steps, checklist, callout, quote, code, image. Keep the chat text to a short lead-in that points to the panel.
- Read-tool results (system_info, disk_usage, list_processes, list_windows, list_reminders, screen_info, ocr_screen, memory_stats, web_search) are ALREADY shown in the Workspace automatically — don't repeat that raw data, but feel free to add a hero/metrics summary or a comparison on top when it helps.
- Math & notation: show symbols properly, not as raw code. Powers and roots are rendered for you — write x^2 or x^{10}, x_1 or x_{10}, \\frac{a}{b}, \\sqrt{a}, and \\lim_{x \\to 0}, \\sum_{i=1}^{n}, \\int_{a}^{b} (the sub/sup after \\lim/\\sum/\\int become little). Common LaTeX commands also become symbols automatically (Greek like \\alpha \\pi \\theta, arrows \\to \\rightarrow, operators \\pm \\times \\div \\cdot, relations \\le \\ge \\ne \\approx, sets \\in \\cup \\cap \\emptyset). For the most reliable look, prefer typing the Unicode directly: ² ³ ⁿ, subscripts like H₂O, vulgar fractions ½ ⅓ ¼, and √ ∑ ∫ ∞ → ≈ ≤ ≥ ≠ × ÷ · π. NEVER put math inside backticks or code blocks (those show literally). No matrices/cases/aligned environments — keep expressions inline.
- Safety: never run a command that deletes, formats, powers off, or otherwise destroys things — call the dedicated tool and let the user confirm. If unsure, explain and ask.
- If a tool fails, say what happened plainly and try a sensible alternative.
- Match the user's language. Be warm but efficient; no filler.`;

/* ==========================================================================
   /api/extract?url=… — read a web page (or a video's captions) as study text,
   or hand back a PDF as base64. SSRF-guarded: only public hosts over http(s),
   and every redirect hop is re-checked.
   ========================================================================== */
const PDF_MAX = 8 * 1024 * 1024, PAGE_MAX = 4 * 1024 * 1024, TEXT_MAX = 600000, FETCH_TIMEOUT = 12000;
const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };

function ipIsPrivate(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19));
    }
    if (net.isIPv6(ip)) {
        const l = ip.toLowerCase();
        if (l === '::' || l === '::1') return true;
        const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (m) return ipIsPrivate(m[1]);
        return /^(fc|fd|fe8|fe9|fea|feb)/.test(l);
    }
    return true;
}
async function assertPublicHost(hostname) {
    if (!hostname || /(^|\.)(localhost|local|internal)$/i.test(hostname)) throw fail(400, 'This link points to a private address');
    if (net.isIP(hostname)) { if (ipIsPrivate(hostname)) throw fail(400, 'This link points to a private address'); return; }
    let addrs;
    try { addrs = await dns.lookup(hostname, { all: true }); }
    catch (e) { throw fail(502, 'Could not resolve ' + hostname); }
    if (!addrs.length || addrs.some(a => ipIsPrivate(a.address))) throw fail(400, 'This link points to a private address');
}
async function safeGet(url) {
    let current = url;
    for (let hop = 0; hop <= 3; hop++) {
        const u = new URL(current);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail(400, 'Only http(s) links are supported');
        await assertPublicHost(u.hostname);
        const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
        let r;
        try {
            r = await fetch(u, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Majin/2.0)', accept: 'text/html,application/pdf,text/plain,*/*' } });
        } catch (e) { throw fail(502, 'Could not reach the link: ' + (e.name === 'AbortError' ? 'it timed out' : e.message)); }
        finally { clearTimeout(timer); }
        if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
            if (r.body) r.body.cancel().catch(() => {});
            current = new URL(r.headers.get('location'), u).href; continue;
        }
        return { res: r, url: u.href };
    }
    throw fail(502, 'Too many redirects');
}
async function readCapped(r, cap, what) {
    const len = +(r.headers.get('content-length') || 0);
    if (len && len > cap) throw fail(413, `The ${what} is too large to read`);
    const reader = r.body.getReader(), chunks = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > cap) { reader.cancel().catch(() => {}); throw fail(413, `The ${what} is too large to read`); } chunks.push(value); }
    return Buffer.concat(chunks);
}
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', deg: '°', times: '×', divide: '÷', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', agrave: 'à', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ccedil: 'ç', frac12: '½', frac14: '¼', sup2: '²', sup3: '³', micro: 'µ', plusmn: '±', ne: '≠', le: '≤', ge: '≥', radic: '√', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', omega: 'ω', phi: 'φ', infin: '∞', sum: '∑', int: '∫', rarr: '→', larr: '←', harr: '↔', aring: 'å', oslash: 'ø', aelig: 'æ' };
const decodeEnt = s => String(s).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, g) => {
    if (g[0] === '#') { const hex = g[1] === 'x' || g[1] === 'X'; const cp = parseInt(hex ? g.slice(2) : g.slice(1), hex ? 16 : 10); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
    const v = NAMED[g.toLowerCase()]; return v !== undefined ? v : m;
});
function metaContent(html, keyName) {
    for (const re of [new RegExp('<meta[^>]+(?:name|property)=["\']' + keyName + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'), new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:name|property)=["\']' + keyName + '["\']', 'i')]) { const m = html.match(re); if (m) return decodeEnt(m[1]).replace(/\s+/g, ' ').trim(); }
    return '';
}
function htmlToText(html) {
    const title = (metaContent(html, 'og:title') || decodeEnt(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')).replace(/\s+/g, ' ').trim()).slice(0, 200);
    let s = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|\/p|\/div|\/section|\/article|\/header|\/footer|\/li|\/ul|\/ol|\/nav|\/h[1-6]|\/tr|\/table|\/blockquote|\/pre|\/figure)[^>]*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]*>/g, ' ');
    s = decodeEnt(s).replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { title, text: s.slice(0, TEXT_MAX), truncated: s.length > TEXT_MAX };
}
const YT = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/;
async function youTubeCaptions(id) {
    const { res } = await safeGet('https://www.youtube.com/watch?v=' + id + '&hl=en');
    if (!res.ok) throw fail(502, 'YouTube answered with an error (' + res.status + ')');
    const html = (await readCapped(res, 3 * 1024 * 1024, 'video page')).toString('utf8');
    const title = metaContent(html, 'title') || metaContent(html, 'og:title') || '';
    const m = html.match(/"captionTracks":(\[.*?\])/);
    let tracks = []; if (m) { try { tracks = JSON.parse(m[1]); } catch (e) {} }
    if (!tracks.length) return null;
    const tr = tracks.find(t => (t.languageCode || '').toLowerCase().startsWith('en')) || tracks[0];
    if (!tr || !tr.baseUrl) return null;
    const cap = await safeGet(tr.baseUrl + '&fmt=json3');
    if (!cap.res.ok) return null;
    const j = JSON.parse((await readCapped(cap.res, 4 * 1024 * 1024, 'captions')).toString('utf8') || '{}');
    const lines = (j.events || []).map(ev => (ev.segs || []).map(sg => sg.utf8 || '').join('').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) return null;
    const full = decodeEnt(lines.join('\n'));
    return { kind: 'text', name: title || ('YouTube video ' + id), title, text: full.slice(0, TEXT_MAX), truncated: full.length > TEXT_MAX, source: 'video captions' };
}
const nameFromUrl = u => { try { const x = new URL(u); const p = decodeURIComponent((x.pathname.split('/').filter(Boolean).pop() || '')).replace(/[_+]/g, ' ').replace(/\.[a-z0-9]{1,5}$/i, '').trim(); return (p || x.hostname.replace(/^www\./, '')).slice(0, 80); } catch (e) { return 'web page'; } };

app.get('/api/extract', async (req, res) => {
    const raw = String(req.query.url || '').trim();
    if (!/^https?:\/\//i.test(raw)) return res.status(400).json({ error: 'Only http(s) links are supported' });
    try {
        const vid = (raw.match(YT) || [])[1];
        if (vid) { const cap = await youTubeCaptions(vid); if (cap) return res.json(cap); throw fail(404, 'No captions were found on this video'); }
        const { res: r, url: finalUrl } = await safeGet(raw);
        if (!r.ok) throw fail(502, `The site answered with an error (${r.status})`);
        const mime = (r.headers.get('content-type') || '').toLowerCase();
        if (mime.includes('pdf') || /\.pdf($|[?#])/i.test(finalUrl)) { const buf = await readCapped(r, PDF_MAX, 'PDF'); return res.json({ kind: 'pdf', name: nameFromUrl(finalUrl), mime: 'application/pdf', data: buf.toString('base64'), size: buf.length }); }
        const body = (await readCapped(r, PAGE_MAX, 'page')).toString('utf8');
        if (mime.includes('html') || /^\s*<(?:!doctype|html|\?xml)/i.test(body)) {
            const { title, text, truncated } = htmlToText(body);
            if (text.replace(/\s+/g, '').length < 40) throw fail(404, 'The page has no readable text (it may need a login or run on JavaScript)');
            return res.json({ kind: 'text', name: title || nameFromUrl(finalUrl), title, text, truncated });
        }
        return res.json({ kind: 'text', name: nameFromUrl(finalUrl), title: '', text: body.slice(0, TEXT_MAX), truncated: body.length > TEXT_MAX });
    } catch (e) { res.status(e.status || 502).json({ error: e.message || 'Could not read this link' }); }
});

/* ==========================================================================
   /api/scan?path=… — walk a local folder and build a module graph (used by the
   scan_repo tool). /api/file?path=… — read one file under a scanned root.
   ========================================================================== */
const SCAN_MAX_FILES = 4000, SCAN_FILE_MAX = 512 * 1024, SCAN_DEPTH = 12, READ_CONCURRENCY = 24;
const SCAN_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.venv', 'venv', 'env', '__pycache__', '.idea', '.vscode', '.qoder', 'coverage', '.cache', '.parcel-cache', 'target', 'vendor', 'bower_components', '.svelte-kit', '.turbo']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.py', '.rb', '.go', '.java', '.php', '.cs', '.c', '.h', '.cpp', '.hpp', '.rs', '.swift', '.kt', '.scala', '.sh']);
const JS_RESOLVE = ['', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.vue', '.svelte', '/index.js', '/index.ts', '/index.tsx', '/index.jsx', '/index.mjs'];
const scannedRoots = new Set();

function extractSpecs(txt, ext) {
    const specs = [];
    if (ext === '.py') {
        for (const m of txt.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import|^[ \t]*import[ \t]+([\w., \t]+)$/gm)) {
            if (m[1]) specs.push(m[1]); else for (const part of m[2].split(',')) { const s = part.trim(); if (s) specs.push(s); }
        }
        return specs;
    }
    for (const m of txt.matchAll(/(?:^|\n)[ \t]*(?:import|export)[ \t][^;\n]*?from[ \t]*['"]([^'"\n]+)['"]/g)) specs.push(m[1]);
    for (const m of txt.matchAll(/(?:^|\n)[ \t]*import[ \t]*['"]([^'"\n]+)['"]/g)) specs.push(m[1]);
    for (const m of txt.matchAll(/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) specs.push(m[1]);
    for (const m of txt.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) specs.push(m[1]);
    return specs;
}
function resolveSpec(spec, fromFile, fileSet, root, ext) {
    if (ext === '.py') {
        let base = path.dirname(fromFile), rest = spec;
        while (rest.startsWith('.')) { rest = rest.slice(1); if (rest.startsWith('.')) base = path.dirname(base); }
        const parts = rest.split('.').filter(Boolean);
        for (const cand of [path.join(base, ...parts) + '.py', path.join(base, ...parts, '__init__.py'), path.join(root, ...parts) + '.py', path.join(root, ...parts, '__init__.py')]) { if (fileSet.has(path.normalize(cand))) return path.normalize(cand); }
        return null;
    }
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), spec.split('?')[0].split('#')[0]);
    for (const cand of JS_RESOLVE) { const p = path.normalize(base + cand); if (fileSet.has(p)) return p; }
    return null;
}
async function walkTree(dir, root, depth, out) {
    if (depth > SCAN_DEPTH || out.files.length >= SCAN_MAX_FILES) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
        if (out.files.length >= SCAN_MAX_FILES) return;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (ent.name.startsWith('.') || SCAN_SKIP.has(ent.name)) continue; await walkTree(full, root, depth + 1, out); }
        else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase(); if (!CODE_EXT.has(ext)) continue;
            let st; try { st = await fs.stat(full); } catch (e) { continue; }
            if (st.size > SCAN_FILE_MAX) { out.tooBig++; continue; }
            out.files.push({ full, rel: path.relative(root, full), ext });
        }
    }
}
async function mapPool(items, n, fn) { const results = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const k = i++; if (k >= items.length) return; results[k] = await fn(items[k], k); } })); return results; }

app.get('/api/scan', async (req, res) => {
    const raw = String(req.query.path || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) return res.status(400).json({ error: 'Pass a folder: /api/scan?path=C:\\projects\\my-app' });
    const root = path.resolve(raw);
    let rootStat; try { rootStat = await fs.stat(root); } catch (e) { return res.status(404).json({ error: 'Folder not found: ' + root }); }
    if (!rootStat.isDirectory()) return res.status(400).json({ error: 'That is a file, not a folder' });
    const out = { files: [], tooBig: 0 };
    await walkTree(root, root, 0, out);
    if (!out.files.length) return res.json({ root, name: path.basename(root), modules: [], edges: [], stats: { files: 0, loc: 0, skipped: out.tooBig, externals: [] }, warnings: ['No code files found here'] });
    const fileSet = new Set(out.files.map(f => f.full));
    await mapPool(out.files, READ_CONCURRENCY, async f => { try { const txt = await fs.readFile(f.full, 'utf8'); f.loc = txt.split('\n').length; f.specs = extractSpecs(txt, f.ext); } catch (e) { f.loc = 0; f.specs = []; } });
    const dirChildren = new Set();
    for (const f of out.files) { const segs = f.rel.split(/[\\/]/); if (segs.length > 1) dirChildren.add(segs[0]); }
    const splitOne = dirChildren.size === 1;
    const modOf = f => { const segs = f.rel.split(/[\\/]/); if (segs.length === 1) return '(root)'; if (splitOne && segs.length > 2) return segs[0] + '/' + segs[1]; if (splitOne) return segs[0] + '/' + segs[1].replace(/\.\w+$/, ''); return segs[0]; };
    const externals = new Map(), internal = new Map();
    for (const f of out.files) {
        const targets = [];
        for (const spec of f.specs || []) {
            const t = resolveSpec(spec, f.full, fileSet, root, f.ext);
            if (t) { if (t !== f.full) targets.push(t); continue; }
            const name = spec.startsWith('.') ? null : (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0].split('.')[0]);
            if (name) externals.set(name, (externals.get(name) || 0) + 1);
        }
        internal.set(f.full, targets);
    }
    const mods = new Map(), modOfFile = new Map();
    for (const f of out.files) {
        const name = modOf(f);
        if (!mods.has(name)) mods.set(name, { name, path: path.dirname(path.join(root, name === '(root)' ? '.' : name.split('/').join(path.sep))), files: [], loc: 0, importsOut: 0, importedBy: 0, entries: [] });
        const m = mods.get(name); m.files.push(f.rel.split(/[\\/]/).join('/')); m.loc += f.loc || 0; modOfFile.set(f.full, name);
    }
    const edgeMap = new Map();
    for (const [fromFile, targets] of internal) {
        const from = modOfFile.get(fromFile);
        for (const t of targets) { const to = modOfFile.get(t); if (!to || to === from) continue; const key = from + '→' + to; edgeMap.set(key, (edgeMap.get(key) || 0) + 1); mods.get(from).importsOut++; mods.get(to).importedBy++; }
    }
    for (const f of out.files) { const m = mods.get(modOfFile.get(f.full)); if ((internal.get(f.full) || []).every(t => modOfFile.get(t) === modOfFile.get(f.full)) && !out.files.some(o => (internal.get(o.full) || []).includes(f.full))) m.entries.push(f.rel.split(/[\\/]/).join('/')); }
    const modules = [...mods.values()].sort((a, b) => b.loc - a.loc).slice(0, 400);
    for (const m of modules) { m.entry = m.entries.slice(0, 4); delete m.entries; }
    const edges = [...edgeMap.entries()].map(([k, weight]) => { const [from, to] = k.split('→'); return { from, to, weight }; });
    scannedRoots.add(root);
    res.json({ root, name: path.basename(root), modules, edges, stats: { files: out.files.length, skippedBig: out.tooBig, loc: modules.reduce((t, m) => t + m.loc, 0), externals: [...externals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, count]) => ({ name, count })) }, warnings: out.files.length >= SCAN_MAX_FILES ? [`Stopped at ${SCAN_MAX_FILES} files — scan a narrower folder for full detail`] : [] });
});
app.get('/api/file', async (req, res) => {
    try {
        const abs = path.resolve(String(req.query.path || '').trim());
        const under = [...scannedRoots].find(r => abs === r || abs.startsWith(r + path.sep));
        if (!under) return res.status(403).json({ error: 'Only files inside a scanned folder can be opened. Scan its repo first.' });
        const st = await fs.stat(abs);
        if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
        if (st.size > 400 * 1024) return res.status(413).json({ error: 'File too large to preview (400KB cap)' });
        const content = await fs.readFile(abs, 'utf8');
        res.json({ path: abs, rel: path.relative(under, abs).split(path.sep).join('/'), name: path.basename(abs), loc: content.split('\n').length, content: content.slice(0, 200000), truncated: content.length > 200000 });
    } catch (e) { res.status(404).json({ error: 'Could not read that file' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', async () => {
    console.log(`Majin assistant running on http://localhost:${PORT}`);
    if (!currentKey()) console.warn(`  ! No key for ${PROVIDERS[liveProvider].label} (${providerConfig(liveProvider).keyEnv}) — the assistant will report this until you add it in Settings.`);
    if (!keyFor('groq')) console.log('  · Tip: add a GROQ_API_KEY in Settings to use Groq as a second, fast provider.');
    await startReminderScheduler();
});

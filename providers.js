/* Majin — provider adapters. One tiny internal format, two (or more) back ends.

   The agent loop in server.js speaks only this normalized language:
     message = {
       role: 'user' | 'assistant',
       content?: string | null,                 // plain text
       images?: [{ mime, data }],               // user turn with inline pictures
       tool_calls?:   [{ id, name, args }],      // assistant turn asking for tools
       tool_results?: [{ id, name, response }],  // user turn feeding results back
     }
   Each adapter (Gemini, Groq/OpenAI) knows how to (a) turn normalized messages
   into its wire format, (b) make ONE streaming call, emitting text deltas as they
   arrive, and (c) turn the response back into a normalized assistant message. The
   loop — running tools, confirming risky actions, repeating — stays provider-agnostic.

   Errors thrown by a call carry `.transient` (worth retrying: 429/5xx/timeout) so
   server.js can back off and surface a "congested, retrying…" notice. */
import crypto from 'node:crypto';

export const PROVIDERS = {
    gemini: {
        label: 'Google Gemini',
        keyEnv: 'GEMINI_API_KEY',
        kind: 'gemini',
        defaultModel: 'gemini-3.5-flash',
        list: 'https://generativelanguage.googleapis.com/v1beta/models',
    },
    groq: {
        label: 'Groq',
        keyEnv: 'GROQ_API_KEY',
        kind: 'openai',
        defaultModel: 'openai/gpt-oss-120b',
        list: 'https://api.groq.com/openai/v1/models',
    },
    // FreeLLMAPI: a self-hosted OpenAI-compatible router that pools ~34 free providers
    // behind one unified key and fails over on 429/5xx on its own — pointing Majin here
    // is what clears the single-provider rate limits and reaches the best free models.
    freellm: {
        label: 'FreeLLMAPI (free pool)',
        keyEnv: 'FREELLMAPI_API_KEY',
        kind: 'openai',
        defaultModel: 'auto',                       // router picks the best available model
        envBase: 'FREELLMAPI_BASE_URL',
        fallbackBase: 'http://localhost:3001/v1',
        listAvailable: true,                        // GET /models?available=true
    }
};
export const PROVIDER_ORDER = ['gemini', 'groq', 'freellm'];

export function providerConfig(provider) { return PROVIDERS[provider] || PROVIDERS.gemini; }

/* Live chat/completions base URL for an OpenAI-compatible provider. Groq is fixed;
   FreeLLMAPI is self-hosted so its address is configurable (env, default localhost). */
export function openaiBase(provider) {
    const cfg = providerConfig(provider);
    if (provider === 'groq') return 'https://api.groq.com/openai/v1';
    const raw = String(process.env[cfg.envBase] || cfg.fallbackBase || '').trim().replace(/\/+$/, '');
    return raw;
}

/* A provider failure. transient=true means "same request may work in a moment"
   (rate limit, overload, network blip, timeout) — the loop retries those;
   transient=false means "won't fix itself" (bad key, bad request, unknown model). */
export class ProviderError extends Error {
    constructor(message, { transient = false, status = 0 } = {}) {
        super(message);
        this.name = 'ProviderError';
        this.transient = transient;
        this.status = status;
    }
}

function looksTransient(status, message) {
    if (status === 429 || status >= 500) return true;
    return /high demand|unavailable|overloaded|rate|timeout|timed out|temporarily|busy|capacity|ETIMEDOUT|socket hang|network/i.test(message || '');
}

/* Pull a "wait N seconds" hint out of a rate-limit message so the caller can back
   off for the RIGHT amount (a per-minute cap needs ~10s, not our 600ms default). */
function parseRetryAfterMs(msg) {
    const m = /retry in ([0-9.]+)\s*s|again in ([0-9.]+)\s*s|in ([0-9.]+)\s*seconds?|after ([0-9.]+)\s*s/i.exec(String(msg || ''));
    if (!m) return 0;
    const s = parseFloat(m[1] || m[2] || m[3] || m[4]);
    return isFinite(s) ? Math.min(20000, Math.round(s * 1000)) : 0;
}

/* Idle deadline: abort only when NOTHING arrives for `ms` (no response headers,
   no streamed chunk). Call guard.kick() on every chunk so a steady stream — even a
   long one — is never cut off, while a hung first token or a stalled socket fails
   fast (the old 3-minute stall). Distinguish a genuine user cancel from a timeout
   via isUserAbort() (their signal fired) vs idleTimedOut (only our timer fired). */
function idleGuard(userSignal, ms) {
    const ctrl = new AbortController();
    let timer = null, idleFired = false;
    const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { idleFired = true; ctrl.abort(new Error('idle timeout')); }, ms); };
    arm();
    const onUserAbort = () => { if (timer) clearTimeout(timer); ctrl.abort(userSignal && userSignal.reason); };
    if (userSignal) {
        if (userSignal.aborted) onUserAbort();
        else userSignal.addEventListener('abort', onUserAbort, { once: true });
    }
    return {
        signal: ctrl.signal,
        kick: arm,
        get idleTimedOut() { return idleFired; },
        isUserAbort: () => !!(userSignal && userSignal.aborted),
        done: () => { if (timer) clearTimeout(timer); if (userSignal) userSignal.removeEventListener('abort', onUserAbort); }
    };
}

/* ---- SSE line reader: yields each `data:` payload as a trimmed string ---- */
async function* sseData(res, kick) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (e) { if (e.name === 'AbortError') throw e; throw new ProviderError('Stream interrupted: ' + e.message, { transient: true }); }
        if (chunk.done) break;
        if (kick) kick();                                            // bytes arrived: keep the stream alive
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line || line.startsWith(':')) continue;           // blank / comment keep-alive
            if (!line.startsWith('data:')) continue;                // ignore `event:`/`id:` fields
            const payload = line.slice(5).trim();
            if (payload && payload !== '[DONE]') yield payload;
        }
    }
    if (reader.releaseLock) { try { reader.releaseLock(); } catch (e) {} }
}

/* =========================================================================
   Message conversion: normalized  <->  each provider's wire format
   ========================================================================= */
function toGeminiContents(messages) {
    const out = [];
    for (const m of messages) {
        if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) continue;   // drop empty turns — they'd fall through as a phantom 'user' turn and break Gemini's alternating-role requirement
        if (m.role === 'assistant' && (m.tool_calls?.length || m.content)) {
            const parts = [];
            if (m.content) parts.push({ text: m.content });
            for (const tc of (m.tool_calls || [])) {
                const part = { functionCall: { name: tc.name, args: tc.args || {} } };
                if (tc.signature) part.thoughtSignature = tc.signature;   // Gemini 3.x: must echo the model's signature back
                parts.push(part);
            }
            out.push({ role: 'model', parts });
        } else if (m.tool_results?.length) {
            out.push({ role: 'user', parts: m.tool_results.map(r => ({ functionResponse: { id: r.id, name: r.name, response: r.response || {} } })) });
        } else {
            const parts = [];
            for (const im of (m.images || [])) parts.push({ inlineData: { mimeType: im.mime || 'image/png', data: im.data } });
            if (m.content) parts.push({ text: m.content });
            if (!parts.length) parts.push({ text: '' });
            out.push({ role: 'user', parts });
        }
    }
    return out;
}
function toOpenAIMessages(messages, system, dropImages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
        if (m.role === 'assistant' && m.tool_calls?.length) {
            out.push({ role: 'assistant', content: m.content || null,
                tool_calls: m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } })) });
        } else if (m.role === 'assistant') {
            out.push({ role: 'assistant', content: m.content || '' });
        } else if (m.tool_results?.length) {
            for (const r of m.tool_results) out.push({ role: 'tool', tool_call_id: r.id, content: typeof r.response === 'string' ? r.response : JSON.stringify(r.response ?? {}) });
        } else {
            const imgs = m.images || [];
            if (imgs.length && !dropImages) {
                const content = [];
                if (m.content) content.push({ type: 'text', text: m.content });
                for (const im of imgs) content.push({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/png'};base64,${im.data}` } });
                out.push({ role: 'user', content });
            } else if (imgs.length) {
                out.push({ role: 'user', content: ((m.content ? m.content + '\n\n' : '') + '[image attached — this model can\'t view images]') });
            } else {
                out.push({ role: 'user', content: m.content || '' });
            }
        }
    }
    return out;
}

/* ---- Gemini: one streaming call, assembled into a normalized assistant turn ---- */
async function callGemini({ model, apiKey, system, messages, tools, onText, signal, timeoutMs }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    const payload = { contents: toGeminiContents(messages), generationConfig: { temperature: 0.55 } };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    if (tools?.length) {
        payload.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
        payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const guard = idleGuard(signal, timeoutMs || 45000);
    let res;
    try {
        res = await fetch(url, { method: 'POST', signal: guard.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(payload) });
    } catch (e) {
        guard.done();
        if (guard.isUserAbort()) throw e;                                  // genuine user cancel
        throw new ProviderError(`Gemini (${model}) ${guard.idleTimedOut ? 'timed out — no reply in time' : 'request failed'}: ${e.message}`, { transient: true });
    }
    if (!res.ok) {
        guard.done();
        const body = await res.text().catch(() => '');
        let msg = ''; try { msg = JSON.parse(body).error?.message || ''; } catch (e) { msg = body.slice(0, 200); }
        const err = new ProviderError(`Gemini ${model} → ${res.status}: ${msg || res.statusText}`, { transient: looksTransient(res.status, msg), status: res.status });
        err.retryAfterMs = res.status === 429 ? parseRetryAfterMs(msg) : 0;
        throw err;
    }
    let text = '';
    const toolCalls = [];
    let finishReason = null;
    let lastSignature = null;                                    // most recent thoughtSignature seen this turn
    try {
        for await (const raw of sseData(res, guard.kick)) {
            let data; try { data = JSON.parse(raw); } catch (e) { continue; }
            const cand = data.candidates?.[0];
            if (!cand) continue;
            if (cand.finishReason) finishReason = cand.finishReason;
            for (const part of (cand.content?.parts || [])) {
                if (part.thoughtSignature) lastSignature = part.thoughtSignature;
                if (part.text) { text += part.text; onText?.(part.text); }
                else if (part.functionCall) {
                    toolCalls.push({ id: part.functionCall.id || ('call_' + toolCalls.length + '_' + crypto.randomBytes(3).toString('hex')),
                        name: part.functionCall.name, args: part.functionCall.args || {},
                        signature: part.thoughtSignature || lastSignature || undefined });
                }
            }
        }
    } finally { guard.done(); }
    const bad = finishReason && /MAX_TOKENS|SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/.test(finishReason) && !text && !toolCalls.length;
    if (bad) throw new ProviderError(`Gemini stopped early (${finishReason})`, { transient: false });
    return { role: 'assistant', content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined };
}

/* ---- OpenAI-compatible (Groq, FreeLLMAPI): one streaming call ---- */
async function callOpenAICompatible({ provider = 'groq', model, apiKey, system, messages, tools, onText, signal, timeoutMs }) {
    const label = providerConfig(provider).label;
    const endpoint = `${openaiBase(provider)}/chat/completions`;
    const hasImages = messages.some(m => m.images?.length);
    const streamOnce = async (dropImages) => {
        const body = { model, messages: toOpenAIMessages(messages, system, dropImages), stream: true, temperature: 0.55 };
        if (tools?.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        const guard = idleGuard(signal, timeoutMs || 45000);
        let res;
        try {
            res = await fetch(endpoint, { method: 'POST', signal: guard.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
        } catch (e) {
            guard.done();
            if (guard.isUserAbort()) throw e;
            throw new ProviderError(`${label} ${guard.idleTimedOut ? 'timed out — no reply in time' : 'request failed'}: ${e.message}`, { transient: true });
        }
        if (!res.ok) {
            guard.done();
            const txt = await res.text().catch(() => '');
            let msg = ''; try { msg = JSON.parse(txt).error?.message || ''; } catch (e) { msg = txt.slice(0, 200); }
            const err = new ProviderError(`${label} ${model} → ${res.status}: ${msg || res.statusText}`, { transient: looksTransient(res.status, msg), status: res.status });
            err.imageRejected = res.status === 400 && /image|vision|modalit|content[ -]type|does not support|multimodal/i.test(msg);
            err.retryAfterMs = res.status === 429 ? parseRetryAfterMs(msg) : 0;
            throw err;
        }
        let text = '';
        const frag = [];                                  // tool-call fragments keyed by index
        try {
            for await (const raw of sseData(res, guard.kick)) {
                let data; try { data = JSON.parse(raw); } catch (e) { continue; }
                const ch = data.choices?.[0];
                if (!ch) continue;
                const d = ch.delta || {};
                if (d.content) { text += d.content; onText?.(d.content); }
                for (const tc of (d.tool_calls || [])) {
                    const i = tc.index ?? 0;
                    if (!frag[i]) frag[i] = { id: tc.id, name: '', args: '' };
                    if (tc.id) frag[i].id = tc.id;
                    if (tc.function?.name) frag[i].name += tc.function.name;
                    if (tc.function?.arguments) frag[i].args += tc.function.arguments;
                }
            }
        } finally { guard.done(); }
        const toolCalls = frag.filter(Boolean).map((f, i) => {
            let args = {};
            try { args = f.args ? JSON.parse(f.args) : {}; } catch (e) { args = {}; }
            return { id: f.id || ('call_' + i + '_' + crypto.randomBytes(3).toString('hex')), name: f.name, args };
        });
        return { role: 'assistant', content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined };
    };
    try {
        return await streamOnce(false);
    } catch (e) {
        if (hasImages && e instanceof ProviderError && e.imageRejected) return streamOnce(true);   // text-only model: degrade images to a note and retry once
        throw e;
    }
}

const ADAPTERS = { gemini: callGemini, groq: callOpenAICompatible, freellm: callOpenAICompatible };

/* One streaming model turn. `provider` picks the adapter; the returned object is a
   normalized assistant message (content + optional tool_calls) ready to push into
   `messages`. */
export async function callProvider({ provider = 'gemini', ...opts }) {
    const fn = ADAPTERS[provider] || ADAPTERS.gemini;
    return fn({ ...opts, provider });
}

/* =========================================================================
   History: accept EITHER normalized turns OR legacy Gemini `contents` so an
   in-flight browser session (localStorage) keeps working across the upgrade.
   ========================================================================= */
function isNormalized(m) { return m && (m.tool_calls || m.tool_results || m.images) ? true : (m.role && !Array.isArray(m.parts)); }

export function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    const out = [];
    for (const m of history) {
        if (!m) continue;
        if (isNormalized(m)) { out.push(m); continue; }
        // legacy Gemini {role, parts:[...]} → normalized
        const role = m.role === 'model' ? 'assistant' : 'user';
        const parts = Array.isArray(m.parts) ? m.parts : [];
        const text = parts.filter(p => p && p.text).map(p => p.text).join('');
        const images = parts.filter(p => p && p.inlineData).map(p => ({ mime: p.inlineData.mimeType, data: p.inlineData.data }));
        const fcs = parts.filter(p => p && p.functionCall).map((p, i) => ({ id: p.functionCall.id || ('call_' + i + '_' + (p.functionCall.name || '')), name: p.functionCall.name, args: p.functionCall.args || {}, signature: p.thoughtSignature || undefined }));
        const frs = parts.filter(p => p && p.functionResponse).map(p => ({ id: p.functionResponse.id || p.functionResponse.name, name: p.functionResponse.name, response: p.functionResponse.response || {} }));
        if (frs.length) out.push({ role: 'user', tool_results: frs });
        else if (role === 'assistant') out.push({ role: 'assistant', content: text || null, tool_calls: fcs.length ? fcs : undefined });
        else out.push({ role: 'user', content: text || null, images: images.length ? images : undefined });
    }
    return out;
}

/* Strip inline image bytes (and any transient _internal fields) before a turn is
   echoed back for the client to store. */
export function stripImages(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    let out = msg;
    if (msg.images?.length) out = { ...out, images: undefined, content: (msg.content ? msg.content + ' ' : '') + '[image attached]' };
    if (Object.keys(out).some(k => k[0] === '_')) {
        out = { ...out };
        for (const k of Object.keys(out)) if (k[0] === '_') delete out[k];
    }
    return out;
}

/* =========================================================================
   Model listing — live from each provider. Returns [{id, label}].
   ========================================================================= */
export async function listModels(provider, apiKey) {
    const cfg = providerConfig(provider);
    if (!apiKey) throw new ProviderError(`No API key saved for ${cfg.label}.`, { transient: false });
    const headers = provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
    let url;
    if (provider === 'gemini') url = cfg.list + `?key=${encodeURIComponent(apiKey)}`;
    else url = `${openaiBase(provider)}/models` + (cfg.listAvailable ? '?available=true' : '');
    const guard = idleGuard(null, 15000);
    let res;
    try { res = await fetch(url, { headers, signal: guard.signal }); }
    catch (e) { throw new ProviderError(`Could not reach ${cfg.label}: ${e.message}`, { transient: true }); }
    finally { guard.done(); }
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new ProviderError(`${cfg.label} model list → ${res.status}`, { transient: looksTransient(res.status, t), status: res.status }); }
    const data = await res.json().catch(() => ({}));
    if (provider === 'gemini') {
        return (data.models || [])
            .filter(m => (m.supportedGenerationMethods || []).some(x => /generateContent/i.test(x)) && !/embedding|aqa|imagen|tuning/i.test(m.name))
            .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, '') }));
    }
    return (data.data || []).map(m => ({ id: m.id, label: m.id })).sort((a, b) => a.id.localeCompare(b.id));
}

/* =========================================================================
   Embeddings (Gemini) — backs semantic memory in tools.js. batchEmbedContents
   takes many texts in one request; we chunk to keep bodies sane. Model is
   env-overridable (MAJIN_EMBED_MODEL) with a fallback to the older
   text-embedding-004 if the newer id is rejected.
   ========================================================================= */
const EMBED_BATCH = 96;
async function embedBatch(model, apiKey, texts) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;
    const body = { requests: texts.map(t => ({ model: `models/${model}`, content: { parts: [{ text: String(t == null ? '' : t) }] } })) };
    const guard = idleGuard(null, 30000);
    let res;
    try {
        res = await fetch(url, { method: 'POST', signal: guard.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
    } catch (e) {
        throw new ProviderError(`Embedding request failed: ${e.message}`, { transient: true });
    } finally { guard.done(); }
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        let msg = ''; try { msg = JSON.parse(t).error?.message || ''; } catch (e) { msg = t.slice(0, 200); }
        const err = new ProviderError(`Embedding ${model} → ${res.status}: ${msg || res.statusText}`, { transient: looksTransient(res.status, msg), status: res.status });
        err.modelRejected = res.status === 404 || (res.status === 400 && /model|not found|unsupported/i.test(msg));
        throw err;
    }
    const data = await res.json().catch(() => ({}));
    const emb = (data.embeddings || []).map(v => v.values || []);
    if (emb.length !== texts.length) throw new ProviderError(`Embedding returned ${emb.length}/${texts.length} vectors`, { transient: true });
    return emb;
}

/* Return one embedding vector per input string, in the same order. */
export async function embedText(texts, { apiKey, model } = {}) {
    const key = String(apiKey || process.env.GEMINI_API_KEY || '').trim();
    if (!key) throw new ProviderError('No GEMINI_API_KEY — semantic memory needs Gemini for embeddings.', { transient: false });
    const list = Array.isArray(texts) ? texts : [texts];
    let useModel = String(model || process.env.MAJIN_EMBED_MODEL || 'gemini-embedding-001').trim();
    const out = [];
    for (let i = 0; i < list.length; i += EMBED_BATCH) {
        const chunk = list.slice(i, i + EMBED_BATCH);
        try {
            const vecs = await embedBatch(useModel, key, chunk);
            out.push(...vecs);
        } catch (e) {
            if (e instanceof ProviderError && e.modelRejected && useModel !== 'text-embedding-004') {
                useModel = 'text-embedding-004';                      // one-time degrade, then retry this chunk
                const vecs = await embedBatch(useModel, key, chunk);
                out.push(...vecs);
            } else throw e;
        }
    }
    return out;
}

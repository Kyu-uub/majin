/* Majin — capability layer (the "Jarvis/Edith" tools).
   Each tool is a plain descriptor plus an async run(args, ctx). The agent in
   server.js turns these into Gemini function declarations, calls run() when the
   model asks for them, and streams the result back.

   Safety: every tool declares a `risk`. Tools flagged 'dangerous' (or shell
   commands matching DANGER) are never executed until the user approves them in
   the UI; server.js enforces that gate before reaching run(). Destructive OS
   actions are confined to this machine and logged. */
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { embedText } from './providers.js';

const IS_WIN = process.platform === 'win32';

/* ---------- helpers ---------- */
// Run a program with args (no shell interpolation → no injection). Returns {code, stdout, stderr}.
function spawnProgram(cmd, args, { timeout = 30000, shell = false } = {}) {
    return new Promise(resolve => {
        const child = execFile(cmd, args, { timeout, shell, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({
                code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                stdout: String(stdout || ''), stderr: String(stderr || '')
            }));
        child.on('error', err => resolve({ code: 127, stdout: '', stderr: err.message }));
    });
}
// PowerShell helper for the OS-integration bits that need .NET / COM.
const ps = (script, timeout = 30000) => spawnProgram('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// File tools are jailed to these roots unless the user widens them. Read is broad;
// write is deliberately narrow (Desktop, Documents, the project).
function allowedRoots() {
    const home = os.homedir();
    return (process.env.MAJIN_FS_ROOTS ? process.env.MAJIN_FS_ROOTS.split(path.delimiter).filter(Boolean) : [
        path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), process.cwd()
    ]);
}
function withinJail(raw, roots) {
    const abs = path.resolve(raw);
    return roots.some(r => abs === r || abs.startsWith(r + path.sep));
}

// withinJail only compares literal strings — path.resolve does NOT follow symlinks,
// so a symlink planted inside an allowed folder could point outside the jail. This
// async guard resolves real paths (fs.realpath) and re-checks containment. For paths
// that don't exist yet (write_file / mkdir), realpath throws ENOENT — we then resolve
// the nearest existing ancestor, which is what a symlink escape would need to exist.
async function resolveWithinJail(raw, roots, what = 'Path') {
    const abs = path.resolve(raw);
    if (!withinJail(abs, roots)) throw new Error(`${what} is outside the allowed folders: ${abs}`);
    let real = abs;
    try { real = await fsp.realpath(abs); }
    catch (e) {
        const { dirname } = path;
        let probe = abs;
        while (true) {
            try { real = await fsp.realpath(probe); real = path.join(real, path.relative(probe, abs)); break; }
            catch (_) { const parent = dirname(probe); if (parent === probe) { real = abs; break; } probe = parent; }
        }
    }
    if (!withinJail(real, roots)) throw new Error(`${what} resolves outside the allowed folders (via a link): ${real}`);
    return real;
}

// Verbs that make a shell command dangerous enough to require confirmation.
const DANGER = /\b(rm|del|erase|rd|rmdir|remove-item|format|diskpart|shutdown|logoff|restart-computer|stop-computer|remove|dd|mkfs|reg\s+delete|taskkill|net\s+user|netsh|vssadmin|cipher|curl|wget|iwr|invoke-webrequest|start-process|schtasks)\b/i;
function commandIsDangerous(cmd) { return DANGER.test(String(cmd)); }

/* ---------- reminders store (in-memory + file) ---------- */
const REMINDER_FILE = path.join(os.tmpdir(), 'majin-reminders.json');
async function loadReminders() { try { return JSON.parse(await fsp.readFile(REMINDER_FILE, 'utf8')); } catch (e) { return []; } }
async function saveReminders(list) { try { await fsp.writeFile(REMINDER_FILE, JSON.stringify(list, null, 2)); } catch (e) {} }

/* ---------- screenshot ---------- */
async function takeScreenshot() {
    if (!IS_WIN) throw new Error('Screenshot tool currently supports Windows only');
    const file = path.join(os.tmpdir(), `majin-shot-${Date.now()}.png`);
    const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
        `$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;` +
        `$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);` +
        `$g=[System.Drawing.Graphics]::FromImage($bmp);` +
        `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);` +
        `$bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);` +
        `$g.Dispose();$bmp.Dispose();`;
    const r = await ps(script, 15000);
    if (r.code !== 0) throw new Error('Screenshot failed: ' + (r.stderr || r.stdout).trim());
    const buf = await fsp.readFile(file);
    await fsp.rm(file, { force: true }).catch(() => {});
    return buf.toString('base64');
}

/* ---------- system info ---------- */
async function systemInfo() {
    const cpus = os.cpus();
    const info = {
        platform: `${os.type()} ${os.release()}`,
        hostname: os.hostname(),
        uptime: Math.round(os.uptime() / 60) + ' min',
        cpus: cpus.length,
        cpuModel: cpus[0] ? cpus[0].model.trim() : 'unknown',
        totalMem: (os.totalmem() / 1e9).toFixed(1) + ' GB',
        freeMem: (os.freemem() / 1e9).toFixed(1) + ' GB',
        home: os.homedir(),
        node: process.version
    };
    if (!IS_WIN) info.load = os.loadavg().map(n => n.toFixed(2));   // loadavg is meaningless (always 0) on Windows
    if (IS_WIN) {
        // Win32_Battery exists only on machines with a battery; BatteryStatus codes:
        // 1=discharging 2=on AC 3=fully charged 4=low 5=critical 6=charging.
        const bat = await ps(`$b=Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue|Select-Object -First 1;` +
            `if($b){$s=@{1='On battery';2='Plugged in';3='Fully charged';4='Low battery';5='Critical';6='Charging'}[[int]$b.BatteryStatus]||('status '+$b.BatteryStatus);` +
            `ConvertTo-Json -Compress -InputObject @{state=$s;percent=[int]$b.EstimatedChargeRemaining}}`, 10000);
        try {
            const t = (bat.stdout || '').trim();
            if (t && t !== 'null') {
                const j = JSON.parse(t);
                if (j && j.percent != null) info.battery = `${j.state} · ${j.percent}%`;
            }
        } catch (e) {}
    }
    return info;
}

/* ---------- Windows toast ---------- */
async function windowsToast(title, body) {
    if (!IS_WIN) return false;
    const esc = s => String(s || '').replace(/'/g, "''");
    const script = `[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null;` +
        `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null;` +
        `$x=New-Object Windows.Data.Xml.Dom.XmlDocument;` +
        `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>');` +
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Majin').Show($x);`;
    const r = await ps(script, 10000);
    return r.code === 0;
}

/* ---------- media keys (play/pause/mute/next/prev) ---------- */
const MEDIA_VK = { play_pause: 0xB3, mute: 0xAD, vol_down: 0xAE, vol_up: 0xAF, next: 0xB0, prev: 0xB1, stop: 0xB2 };
async function mediaKey(key) {
    const vk = MEDIA_VK[key];
    if (!vk) throw new Error('Unknown media key: ' + key);
    const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;' +` +
        `'public class M{[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,ref int e);' +` +
        `[DllImport("user32.dll")]public static extern uint MapVirtualKey(uint u,uint m);' +` +
        `public static void Send(byte k){int e=0;uint s=MapVirtualKey(k,0);keybd_event(k,s,0,ref e);keybd_event(k,s,2,ref e);}}';` +
        `[M]::Send(${vk});`;
    const r = await ps(script, 10000);
    if (r.code !== 0) throw new Error('Media key failed: ' + (r.stderr || '').trim());
    return 'Sent ' + key;
}

/* ---------- power ---------- */
async function power(action, force) {
    const a = String(action).toLowerCase();
    if (!IS_WIN) throw new Error('Power control supports Windows only');
    switch (a) {
        case 'lock': await spawnProgram('rundll32.exe', ['user32.dll,LockWorkStation']); return 'Workstation locked';
        case 'sleep': await spawnProgram('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']); return 'Sleeping';
        case 'logoff': await spawnProgram('shutdown', ['/l']); return 'Logging off';
        case 'shutdown': await spawnProgram('shutdown', ['/s', '/t', force ? '5' : '15']); return 'Shutting down';
        case 'restart': await spawnProgram('shutdown', ['/r', '/t', force ? '5' : '15']); return 'Restarting';
        case 'abort': await spawnProgram('shutdown', ['/a']); return 'Cancelled pending shutdown/restart';
        default: throw new Error('Unknown power action: ' + a);
    }
}

/* ---------- capability helpers (processes / windows / clipboard / disk) ---------- */
// Free text -> base64 -> decoded inside PowerShell, so quotes/newlines/; can never
// break out of the command (no shell interpolation on the JS side, no PS injection).
const toBase64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const b64Arg = b64 => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`;
const stripTags = s => String(s).replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, d) => (d > 0 && d <= 0x10ffff ? String.fromCodePoint(+d) : m)).replace(/\s+/g, ' ').trim();
// Run a PowerShell script that emits ConvertTo-Json, return the parsed rows as an array.
async function psJson(script, timeout = 20000) {
    const r = await ps(script, timeout);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'command failed').trim());
    const txt = (r.stdout || '').trim();
    if (!txt) return [];
    let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('Could not parse output: ' + txt.slice(0, 200)); }
    return Array.isArray(j) ? j : [j];
}

/* =========================================================================
   Screen geometry, computer use (input synthesis) and on-screen OCR.
   ========================================================================= */
async function screenGeometry() {
    const script = `Add-Type -AssemblyName System.Windows.Forms;` +
        `$p=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;` +
        `$v=[System.Windows.Forms.SystemInformation]::VirtualScreen;` +
        `$mon=[System.Windows.Forms.Screen]::AllScreens|ForEach-Object{$b=$_.Bounds;` +
        `[pscustomobject]@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height;primary=[bool]$_.Primary}};` +
        `[pscustomobject]@{primary=@{x=$p.X;y=$p.Y;width=$p.Width;height=$p.Height};` +
        `virtual=@{x=$v.X;y=$v.Y;width=$v.Width;height=$v.Height};monitors=$mon}|ConvertTo-Json -Compress -Depth 4`;
    const r = await ps(script, 12000);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'screen info failed').trim());
    return JSON.parse(r.stdout.trim());
}

// Win32 input. A static C# class is compiled in-proc on each call; SetProcessDPIAware
// runs in the static ctor so pixel coordinates match physical screen pixels.
const INPUT_CS =
    'using System;using System.Runtime.InteropServices;' +
    'public static class Inp{' +
    '[DllImport("user32.dll")] static extern bool SetCursorPos(int X,int Y);' +
    '[DllImport("user32.dll")] static extern uint SendInput(uint n,INPUT[] p,int cb);' +
    '[DllImport("user32.dll")] static extern bool SetProcessDPIAware();' +
    '[DllImport("user32.dll")] static extern ushort VkKeyScan(char c);' +
    '[StructLayout(LayoutKind.Sequential)] struct MI{public int dx;public int dy;public uint mouseData;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}' +
    '[StructLayout(LayoutKind.Sequential)] struct KI{public ushort wVk;public ushort wScan;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}' +
    '[StructLayout(LayoutKind.Explicit)] struct INPUT{[FieldOffset(0)]public uint type;[FieldOffset(8)]public MI mi;[FieldOffset(8)]public KI ki;}' +
    'const uint LD=0x2,LU=0x4,RD=0x8,RU=0x10,MD=0x20,MU=0x40,WHEEL=0x800,UNI=0x4,KUP=0x2;' +
    'static Inp(){try{SetProcessDPIAware();}catch{}}' +
    'static INPUT M(int dx,int dy,uint data,uint f){var i=new INPUT();i.type=0;i.mi.dx=dx;i.mi.dy=dy;i.mi.mouseData=data;i.mi.dwFlags=f;i.mi.dwExtraInfo=IntPtr.Zero;return i;}' +
    'static INPUT K(ushort vk,ushort scan,uint f){var i=new INPUT();i.type=1;i.ki.wVk=vk;i.ki.wScan=scan;i.ki.dwFlags=f;i.ki.time=0;i.ki.dwExtraInfo=IntPtr.Zero;return i;}' +
    'static void Send(INPUT[] a){SendInput((uint)a.Length,a,Marshal.SizeOf(typeof(INPUT)));}' +
    'public static void Move(int x,int y){SetCursorPos(x,y);}' +
    'public static void Click(string b,int n){uint d,u;if(b=="right"){d=RD;u=RU;}else if(b=="middle"){d=MD;u=MU;}else{d=LD;u=LU;}int k=(n<1)?1:n;for(int i=0;i<k;i++){Send(new INPUT[]{M(0,0,0,d),M(0,0,0,u)});if(k>1)System.Threading.Thread.Sleep(45);}}' +
    'public static void Down(string b){uint d;if(b=="right")d=RD;else if(b=="middle")d=MD;else d=LD;Send(new INPUT[]{M(0,0,0,d)});}' +
    'public static void Up(string b){uint u;if(b=="right")u=RU;else if(b=="middle")u=MU;else u=LU;Send(new INPUT[]{M(0,0,0,u)});}' +
    'public static void Wheel(int amount){Send(new INPUT[]{M(0,0,unchecked((uint)amount),WHEEL)});}' +
    'public static void Drag(int x1,int y1,int x2,int y2){SetCursorPos(x1,y1);Send(new INPUT[]{M(0,0,0,LD)});System.Threading.Thread.Sleep(20);SetCursorPos(x2,y2);System.Threading.Thread.Sleep(20);Send(new INPUT[]{M(0,0,0,LU)});}' +
    'public static void Type(string t){var l=new System.Collections.Generic.List<INPUT>();foreach(char c in t){l.Add(K(0,c,UNI));l.Add(K(0,c,UNI|KUP));}Send(l.ToArray());}' +
    'static ushort VK(string s){switch(s){case "enter":case "return":return 0x0D;case "tab":return 0x09;case "esc":case "escape":return 0x1B;case "space":return 0x20;case "backspace":return 0x08;case "delete":case "del":return 0x2E;case "insert":return 0x2D;case "home":return 0x24;case "end":return 0x23;case "pageup":case "pgup":return 0x21;case "pagedown":case "pgdn":return 0x22;case "left":return 0x25;case "up":return 0x26;case "right":return 0x27;case "down":return 0x28;case "win":case "super":case "meta":return 0x5B;case "printscreen":return 0x2C;}' +
    'if(s.Length==1)return (ushort)(VkKeyScan(s[0])&0xFF);' +
    'if(s.StartsWith("f")&&s.Length>=2&&s.Length<=3){int num=int.Parse(s.Substring(1));if(num>=1&&num<=12)return (ushort)(0x6F+num);}' +
    'throw new Exception("unknown key: "+s);}' +
    'public static void Combo(string combo){string[] p=combo.ToLower().Split((char)43);var down=new System.Collections.Generic.List<INPUT>();var up=new System.Collections.Generic.List<INPUT>();string main=p[p.Length-1];for(int i=0;i<p.Length-1;i++){ushort mv=0;string m=p[i];if(m=="ctrl"||m=="control")mv=0x11;else if(m=="alt")mv=0x12;else if(m=="shift")mv=0x10;else if(m=="win"||m=="super"||m=="meta")mv=0x5B;else continue;down.Add(K(mv,0,0));up.Add(K(mv,0,KUP));}ushort k=VK(main);down.Add(K(k,0,0));up.Add(K(k,0,KUP));Send(down.ToArray());Send(up.ToArray());}' +
    '}';

const toInt = v => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw new Error('Expected a whole number, got: ' + v); return n; };
const safeButton = b => ['left', 'right', 'middle'].includes(String(b)) ? String(b) : 'left';

async function runInput(call, timeout = 12000) {
    const r = await ps(`Add-Type -TypeDefinition '${INPUT_CS}'\n${call}`, timeout);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'input failed').trim().slice(-300));
    return true;
}

// Capture a screen rectangle to a temp PNG; returns its path. Numbers are validated.
async function captureRegion(rect) {
    if (!IS_WIN) throw new Error('Screen capture supports Windows only');
    const file = path.join(os.tmpdir(), `majin-cap-${Date.now()}.png`);
    const safePath = file.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Drawing,System.Windows.Forms;` +
        `$f='${safePath}';` +
        `$b=New-Object System.Drawing.Bitmap(${rect.width},${rect.height});` +
        `$g=[System.Drawing.Graphics]::FromImage($b);` +
        `$g.CopyFromScreen(${rect.x},${rect.y},0,0,$b.Size);` +
        `$b.Save($f,[System.Drawing.Imaging.ImageFormat]::Png);` +
        `$g.Dispose();$b.Dispose();$f`;
    const r = await ps(script, 15000);
    if (r.code !== 0) throw new Error('Capture failed: ' + (r.stderr || r.stdout).trim());
    return file;
}

// Windows.Media.Ocr (WinRT) run over a PNG file. Returns lines in IMAGE coordinates.
// Built as double-quoted JS lines (the PS uses single-quoted type-name strings, one of
// which contains a backtick in IAsyncOperation`1).
function ocrScript(file) {
    const lines = [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
        "[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null",
        "[Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]|Out-Null",
        "[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]|Out-Null",
        "[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]|Out-Null",
        "[Windows.Media.Ocr.OcrResult,Windows.Media.Ocr,ContentType=WindowsRuntime]|Out-Null",
        "[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]|Out-Null",
        "$one=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1}",
        "$ao=$one|Where-Object{$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'}|Select-Object -First 1",
        "$ap=$one|Where-Object{$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperationWithProgress`2'}|Select-Object -First 1",
        "function AwaitO($op,$t){$m=$ao.MakeGenericMethod($t);$x=$m.Invoke($null,@($op));$x.Wait(-1)|Out-Null;return $x.Result}",
        "function AwaitP($op,$r,$p){$m=$ap.MakeGenericMethod($p,$r);$x=$m.Invoke($null,@($op));$x.Wait(-1)|Out-Null;return $x.Result}",
        "$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + toBase64(file) + "'))",
        "$f=AwaitO ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])",
        "$st=AwaitO ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
        "$dec=AwaitO ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($st)) ([Windows.Graphics.Imaging.BitmapDecoder])",
        "$bmp=AwaitO ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)) ([Windows.Graphics.Imaging.SoftwareBitmap])",
        "$eng=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()",
        "if($null -eq $eng){$lg=New-Object Windows.Globalization.Language('en-US');$eng=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lg)}",
        "if($null -eq $eng){throw 'No OCR language pack is installed on this PC'}",
        "$res=AwaitP ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult]) ([Windows.Media.Ocr.OcrResult])",
        "$out=@();foreach($ln in $res.Lines){$bb=$ln.BoundingRect;$out+=[pscustomobject]@{text=$ln.Text;x=[int]$bb.X;y=[int]$bb.Y;w=[int]$bb.Width;h=[int]$bb.Height}}",
        "if($out.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject @($out) -Compress}"
    ];
    return lines.join('\n');
}
async function runOcrOnFile(file) {
    const r = await ps(ocrScript(file), 40000);
    if (r.code !== 0) throw new Error('OCR failed: ' + (r.stderr || r.stdout || 'unknown').trim().slice(-400));
    const txt = (r.stdout || '').trim();
    if (!txt) return [];
    let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('OCR returned unparseable output: ' + txt.slice(0, 160)); }
    return Array.isArray(j) ? j : (j ? [j] : []);
}

/* =========================================================================
   Semantic memory — embed chunks of text/code files and cosine-search them.
   ========================================================================= */
const MEMORY_DIR = process.env.MAJIN_MEMORY_DIR
    ? path.resolve(expandHome(process.env.MAJIN_MEMORY_DIR))
    : path.join(os.homedir(), '.majin');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.json', '.jsonc',
    '.yaml', '.yml', '.xml', '.html', '.htm', '.ini', '.cfg', '.conf', '.log', '.env', '.toml',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
    '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php', '.swift', '.sql', '.sh', '.bash', '.ps1',
    '.bat', '.css', '.scss', '.less', '.vue', '.svelte']);
const FS_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', '.idea', '.venv', 'venv', '__pycache__', '.majin']);

async function loadMemory() {
    try { const j = JSON.parse(await fsp.readFile(MEMORY_FILE, 'utf8')); return (j && Array.isArray(j.chunks)) ? j : { version: 1, chunks: [] }; }
    catch (e) { return { version: 1, chunks: [] }; }
}
async function saveMemory(m) {
    await fsp.mkdir(MEMORY_DIR, { recursive: true });
    await fsp.writeFile(MEMORY_FILE, JSON.stringify(m));
}
function chunkText(text, size = 1000, overlap = 160) {
    const clean = String(text || '').replace(/\r\n/g, '\n');
    if (clean.length <= size) return clean.trim() ? [clean.trim()] : [];
    const out = [];
    for (let start = 0; start < clean.length; start += (size - overlap)) {
        const slice = clean.slice(start, start + size).trim();
        if (slice) out.push(slice);
        if (start + size >= clean.length) break;
    }
    return out;
}
async function extractText(abs) {
    const st = await fsp.stat(abs);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return null;                       // binary guard (NUL byte)
    return buf.toString('utf8');
}
function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
async function walkInto(root, files, limit) {
    if (files.length >= limit) return;
    let ents; try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
        if (files.length >= limit) return;
        if (e.name.startsWith('.') || FS_SKIP.has(e.name)) continue;
        const full = path.join(root, e.name);
        if (e.isDirectory()) await walkInto(full, files, limit);
        else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
            try { const st = await fsp.stat(full); if (st.size <= 2 * 1024 * 1024) files.push({ p: full, mtime: st.mtimeMs }); } catch (x) {}
        }
    }
}

/* ---------- the tool registry ---------- */
// Gemini function-declaration friendly: every parameter is described, types are primitives.
export const TOOLS = [
    {
        name: 'open_app', risk: 'dangerous',
        description: 'Launch a locally installed application or a known Windows app (Notepad, Calculator, Paint, Explorer, Settings, Terminal, Edge, Chrome, Word, Excel, …). This starts a real program on the PC, so it asks the user to confirm first.',
        parameters: {
            type: 'object', properties: {
                app: { type: 'string', description: 'Application name or executable' },
                args: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments' }
            }, required: ['app']
        },
        run: async ({ app, args }) => {
            const known = { notepad: 'notepad', calculator: 'calc', calc: 'calc', paint: 'mspaint', explorer: 'explorer', settings: 'ms-settings:', terminal: 'wt', cmd: 'cmd', edge: 'msedge', chrome: 'chrome', word: 'winword', excel: 'excel', powershell: 'powershell' };
            const key = String(app || '').toLowerCase().trim();
            let exe = known[key];
            if (!exe) {
                // Unknown app: accept only a bare executable name (no path separators, drive
                // letters or cmd metacharacters) — then it is execFile'd directly (no shell),
                // so nothing can be chained onto it.
                if (/[;&|<>^%$`"'\\\/]/.test(key) || /\s/.test(key)) throw new Error('Unsafe application name: ' + app);
                exe = key;
            }
            // Launch the target directly (NOT via `cmd /c start`) so shell metacharacters
            // in the name/args can never start a second command. URI schemes (ms-settings:)
            // go through explorer.exe — still no cmd shell. A GUI app never exits, so we
            // resolve the moment 'spawn' confirms the process started (reject on 'error')
            // and then unref/detach so it runs independently without blocking the turn.
            const viaExplorer = /^[a-z][a-z0-9+.\-]*:/i.test(exe);   // "ms-settings:" etc.
            const [prog, argv] = viaExplorer ? ['explorer.exe', [exe]] : [exe, (args || []).map(String)];
            await new Promise((resolve, reject) => {
                let child;
                try { child = spawn(prog, argv, { windowsHide: true, detached: true, stdio: 'ignore' }); }
                catch (e) { return reject(new Error('Could not launch ' + app + ': ' + e.message)); }
                child.once('error', e => reject(new Error('Could not launch ' + app + ': ' + e.message)));
                child.once('spawn', () => { child.unref(); resolve(); });
            });
            return { opened: app };
        }
    },
    {
        name: 'open_url', risk: 'safe',
        description: 'Open a web address in the user’s default browser.',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full http(s) URL' } }, required: ['url'] },
        run: async ({ url }) => {
            if (!/^https?:\/\//i.test(url)) throw new Error('Provide a full http(s) URL');
            // explorer.exe opens the default browser without a cmd shell, so no metacharacter
            // in the URL can be interpreted as a second command (unlike `cmd /c start`).
            const opener = IS_WIN ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
            const r = await spawnProgram(opener, [String(url)], { timeout: 8000 });
            if (r.code !== 0 && r.stderr) throw new Error('Could not open the link: ' + r.stderr.trim());
            return { opened: url };
        }
    },
    {
        name: 'run_command', risk: 'dangerous',
        description: 'Run a shell command on this machine and capture its output. Used for system tasks, dev commands, git, package installs, etc. Never use it to delete/format/power-off — call those specific tools instead.',
        parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command line to execute' }, cwd: { type: 'string', description: 'Optional working directory' } }, required: ['command'] },
        run: async ({ command, cwd }) => {
            let useCwd;
            if (cwd) {
                const abs = path.resolve(expandHome(cwd));
                if (!withinJail(abs, allowedRoots().concat(systemRoots()))) throw new Error('Working directory is outside the allowed folders: ' + abs);
                useCwd = abs;
            }
            const r = await spawnProgram(IS_WIN ? 'cmd' : '/bin/bash', [IS_WIN ? '/c' : '-c', command], { timeout: 120000, cwd: useCwd });
            return { exitCode: r.code, stdout: r.stdout.slice(0, 40000), stderr: r.stderr.slice(0, 8000) };
        }
    },
    {
        name: 'install', risk: 'dangerous',
        description: 'Actually install software for the user instead of only telling them the command. Default uses Windows winget (searches the app name and installs it); kind can be app|winget for programs, or npm|pip for code libraries (pass cwd for the project folder). This changes the system, so it always asks the user to confirm first.',
        parameters: {
            type: 'object', properties: {
                target: { type: 'string', description: 'What to install — app name (e.g. "VLC", "Git", "Python") or package name (e.g. "requests", "lodash")' },
                kind: { type: 'string', enum: ['app', 'winget', 'npm', 'pip', 'auto'], description: 'How to install. app/winget/auto use winget; npm/pip use that package manager. Default auto (winget).' },
                package: { type: 'string', description: 'Exact winget package id (e.g. "VideoLAN.VLC") if known — more reliable than the name. Leave blank to search by target.' },
                cwd: { type: 'string', description: 'Project folder for npm/pip installs (optional)' }
            }, required: ['target']
        },
        run: async ({ target, kind = 'auto', package: pkg, cwd }) => {
            const t = String(target || '').trim();
            if (!t) throw new Error('Nothing specified to install.');
            // npm/pip go through cmd → allow only safe package-name characters.
            const safePkg = v => { const s = String(v).trim(); if (!/^[A-Za-z0-9@._\/+-]{1,120}$/.test(s)) throw new Error('Unsafe package name: ' + s); return s; };
            // winget is execFile’d directly (no shell), but still block quotes/newlines/metacharacters.
            const safeName = v => { const s = String(v).trim(); if (!/^[\w .()+#@\/-]{1,120}$/.test(s)) throw new Error('Unsafe app name: ' + s); return s; };
            const FLAGS = ['--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'];

            let cmd, args;
            if (kind === 'npm') { cmd = 'cmd'; args = ['/c', 'npm', 'install', safePkg(t)]; }
            else if (kind === 'pip') { cmd = 'cmd'; args = ['/c', 'python', '-m', 'pip', 'install', safePkg(t)]; }
            else {
                cmd = 'winget';
                args = pkg && String(pkg).trim()
                    ? ['install', '--id', safePkg(pkg), '-e', ...FLAGS]
                    : ['install', safeName(t), ...FLAGS];
            }
            const useCwd = cwd && withinJail(path.resolve(expandHome(cwd)), allowedRoots().concat(systemRoots())) ? path.resolve(expandHome(cwd)) : undefined;

            const r = await spawnProgram(cmd, args, { timeout: 600000, cwd: useCwd });
            const out = (r.stdout || ''), err = (r.stderr || '');
            const wingetMissing = cmd === 'winget' && (r.code === 127 || /not recognized|no such file|not found/i.test(err + out));
            const ok = r.code === 0 && !wingetMissing;
            const message = wingetMissing
                ? 'Windows winget isn’t available — enable the free “App Installer” from the Microsoft Store, then try again.'
                : ok ? `Installed ${t}.` : `Install of ${t} didn’t complete — see the details.`;
            return { ok, kind: cmd === 'winget' ? (pkg ? 'winget:id' : 'winget:name') : kind, command: [cmd, ...args].join(' '), exitCode: r.code, stdout: out.slice(0, 8000), stderr: err.slice(0, 4000), message };
        }
    },
    {
        name: 'list_directory', risk: 'safe',
        description: 'List the files and folders inside a directory.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder path' } }, required: ['path'] },
        run: async ({ path: p }) => {
            const abs = await resolveWithinJail(expandHome(p), allowedRoots().concat(systemRoots()), 'Folder');
            const entries = await fsp.readdir(abs, { withFileTypes: true });
            const out = [];
            for (const e of entries.slice(0, 500)) {
                let size = null; try { if (e.isFile()) size = (await fsp.stat(path.join(abs, e.name))).size; } catch (x) {}
                out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size });
            }
            return { path: abs, count: out.length, entries: out };
        }
    },
    {
        name: 'read_file', risk: 'safe',
        description: 'Read a UTF-8 text file (up to 400 KB).',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] },
        run: async ({ path: p }) => {
            const abs = await resolveWithinJail(expandHome(p), allowedRoots().concat(systemRoots()), 'File');
            const st = await fsp.stat(abs);
            if (!st.isFile()) throw new Error('Not a file');
            if (st.size > 400 * 1024) throw new Error('File too large (400 KB cap)');
            return { path: abs, size: st.size, content: (await fsp.readFile(abs, 'utf8')).slice(0, 200000) };
        }
    },
    {
        name: 'write_file', risk: 'conditional', dangerousWhen: ({ path: p }) => !withinJail(path.resolve(expandHome(p)), allowedRoots()),
        description: 'Create or overwrite a text file inside the Desktop/Documents/Downloads/project folders.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Text to write' }, append: { type: 'boolean', description: 'Append instead of overwrite' } }, required: ['path', 'content'] },
        run: async ({ path: p, content, append }) => {
            const abs = await resolveWithinJail(expandHome(p), allowedRoots(), 'Write path');
            await fsp.mkdir(path.dirname(abs), { recursive: true });
            await fsp[append ? 'appendFile' : 'writeFile'](abs, String(content), 'utf8');
            return { wrote: abs, bytes: Buffer.byteLength(String(content)) };
        }
    },
    {
        name: 'search_files', risk: 'safe',
        description: 'Search for files by name under a folder (recursive, skips node_modules/.git).',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Root folder' }, query: { type: 'string', description: 'Name substring (case-insensitive)' } }, required: ['path', 'query'] },
        run: async ({ path: p, query }) => {
            const root = await resolveWithinJail(expandHome(p), allowedRoots().concat(systemRoots()), 'Folder');
            const q = String(query).toLowerCase();
            const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', '.idea', '.venv', '__pycache__']);
            const hits = []; let seen = 0;
            async function walk(d, depth) {
                if (depth > 8 || hits.length >= 200 || seen > 40000) return;
                let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
                for (const e of ents) {
                    seen++; if (hits.length >= 200 || seen > 40000) return;
                    const full = path.join(d, e.name);
                    if (e.isSymbolicLink()) continue;   // never follow links out of the jail
                    if (e.isDirectory()) { if (!e.name.startsWith('.') && !skip.has(e.name)) await walk(full, depth + 1); }
                    else if (e.name.toLowerCase().includes(q)) hits.push(full);
                }
            }
            await walk(root, 0);
            return { root, query, matches: hits.length, files: hits };
        }
    },
    {
        name: 'system_info', risk: 'safe',
        description: 'Report OS, hardware, memory, uptime, battery and Node details of this machine.',
        parameters: { type: 'object', properties: {} },
        run: () => systemInfo()
    },
    {
        name: 'screenshot', risk: 'safe',
        description: 'Capture the full screen and attach the image so you can read what is on it (answer questions about the current display).',
        parameters: { type: 'object', properties: {} },
        run: async () => { const b64 = await takeScreenshot(); return { ok: true, note: 'Screen captured and shown to the user.', _image: b64 }; }
    },
    {
        name: 'media_key', risk: 'safe',
        description: 'Send a media key: play_pause, mute, vol_up, vol_down, next, prev, stop.',
        parameters: { type: 'object', properties: { key: { type: 'string', enum: Object.keys(MEDIA_VK) } }, required: ['key'] },
        run: async ({ key }) => ({ result: await mediaKey(key) })
    },
    {
        name: 'power', risk: 'dangerous',
        description: 'Lock, sleep, log off, shut down, or restart the machine (or abort a pending shutdown). These are always user-confirmed.',
        parameters: { type: 'object', properties: { action: { type: 'string', enum: ['lock', 'sleep', 'logoff', 'shutdown', 'restart', 'abort'] }, force: { type: 'boolean', description: 'For shutdown/restart, use the short 5s delay instead of the 15s grace period' } }, required: ['action'] },
        run: async ({ action, force }) => ({ result: await power(action, force) })
    },
    {
        name: 'notify', risk: 'safe',
        description: 'Show a Windows toast notification (independent of the chat).',
        parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
        run: async ({ title, body }) => ({ delivered: await windowsToast(title, body) })
    },
    {
        name: 'set_reminder', risk: 'safe',
        description: 'Set a reminder that fires in N seconds. Majin will toast and show it when due.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'What to remind about' }, seconds: { type: 'number', description: 'Delay in seconds' } }, required: ['text', 'seconds'] },
        run: async ({ text, seconds }) => {
            const when = Date.now() + Math.max(1, Math.min(seconds, 24 * 3600)) * 1000;
            const id = crypto.randomBytes(4).toString('hex');
            const list = await loadReminders();
            list.push({ id, text, when }); await saveReminders(list);
            schedule(id, text, when);
            return { id, fires: new Date(when).toLocaleString() };
        }
    },
    {
        name: 'list_reminders', risk: 'safe',
        description: 'List pending reminders.',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ reminders: (await loadReminders()).map(r => ({ id: r.id, text: r.text, fires: new Date(r.when).toLocaleString() })) })
    },
    {
        name: 'show_blocks', risk: 'safe',
        description: 'Present content as rich, animated widgets in the Workspace panel on the right — this is your default canvas. Use it liberally for dashboards, summaries, comparisons, plans, guides, data, and anything that reads better visually than as a chat paragraph; keep the chat text to a short lead-in. Numeric stats and bars animate (count-up numbers, filling progress bars). Block types: hero (banner title+subtitle+tone), metrics (grid of count-up stat cards via stats), progress (animated bars via bars, each value/max), timeline (items as milestone steps), chips (items as badge row), table (table), keyvalue (pairs), list (items), steps (items), checklist (items, tickable), quote (body), callout (body+tone), code (body), image (url), heading (title), text (body), divider, gauge (animated circular ring via value/max/unit/tone — a single fill percentage that sweeps and counts up), spark (animated self-drawing sparkline via series: ordered numeric strings).',
        parameters: {
            type: 'object', properties: {
                title: { type: 'string' },
                blocks: {
                    type: 'array', description: 'Ordered content blocks', items: {
                        type: 'object', properties: {
                            type: { type: 'string', enum: ['hero', 'metrics', 'progress', 'timeline', 'chips', 'heading', 'text', 'list', 'steps', 'checklist', 'table', 'keyvalue', 'callout', 'code', 'image', 'quote', 'divider', 'gauge', 'spark'] },
                            title: { type: 'string' },
                            body: { type: 'string', description: 'hero subtitle / text/callout/code/quote body' },
                            items: { type: 'array', items: { type: 'string' } },
                            stats: { type: 'array', description: 'for metrics cards', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string', description: 'number to count up, or a string like "12 GB"' }, unit: { type: 'string' }, tone: { type: 'string', enum: ['info', 'success', 'warn', 'danger'] } }, required: ['label', 'value'] } },
                            bars: { type: 'array', description: 'for progress', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, max: { type: 'string' }, unit: { type: 'string' }, tone: { type: 'string', enum: ['info', 'success', 'warn', 'danger'] } }, required: ['label', 'value'] } },
                            value: { type: 'string', description: 'gauge: the number the ring fills to' },
                            max: { type: 'string', description: 'gauge: the value a full ring represents (default 100)' },
                            unit: { type: 'string', description: 'gauge: small unit suffix shown next to the number' },
                            series: { type: 'array', description: 'spark: ordered data points as numeric strings', items: { type: 'string' } },
                            pairs: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
                            table: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }, required: ['headers', 'rows'] },
                            url: { type: 'string', description: 'image src' },
                            tone: { type: 'string', enum: ['info', 'success', 'warn', 'danger'] }
                        }, required: ['type']
                    }
                }
            }, required: ['blocks']
        },
        run: async ({ title, blocks }, ctx) => { (ctx && ctx.emit || (() => {}))({ type: 'workspace', title, blocks }); return { shown: (blocks || []).length }; }
    },
    {
        name: 'read_url', risk: 'safe',
        description: 'Fetch a web page or link and return its readable text (or PDF as base64).',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        run: async ({ url }) => {
            const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/extract?url=${encodeURIComponent(url)}`, { headers: { host: 'localhost' } });
            const j = await r.json();
            if (j.error) throw new Error(j.error);
            if (j.text && j.text.length > 60000) j.text = j.text.slice(0, 60000) + '\n[...truncated...]';
            return j;
        }
    },
    {
        name: 'scan_repo', risk: 'safe',
        description: 'Analyse a local code folder and return its module graph and health metrics (files, LOC, external deps, import edges).',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        run: async ({ path: p }) => {
            const root = await resolveWithinJail(expandHome(p), allowedRoots().concat(systemRoots()), 'Folder');
            const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/scan?path=${encodeURIComponent(root)}`, { headers: { host: 'localhost' } });
            const j = await r.json();
            if (j.error) throw new Error(j.error);
            if (j.modules && j.modules.length > 40) j.modules = j.modules.slice(0, 40);
            return j;
        }
    },
    {
        name: 'manage_files', risk: 'conditional', dangerousWhen: ({ op }) => op === 'delete',
        description: 'Organise the file system: move, copy, rename, delete a file/folder, or create a folder (mkdir). Deleting is destructive and always asks the user first. Writes stay inside Desktop/Documents/Downloads/the project folder.',
        parameters: {
            type: 'object', properties: {
                op: { type: 'string', enum: ['move', 'copy', 'rename', 'delete', 'mkdir'], description: 'The operation to perform' },
                src: { type: 'string', description: 'Existing path to act on (move/copy/rename/delete). For rename it is the current path.' },
                dest: { type: 'string', description: 'Destination path for move/copy/rename, or the new folder for mkdir. Omit for delete.' }
            }, required: ['op']
        },
        run: async ({ op, src, dest }) => {
            const writeRoots = allowedRoots();
            const readRoots = allowedRoots().concat(systemRoots());
            const need = async (p, roots, what) => resolveWithinJail(expandHome(p || ''), roots, what);
            switch (String(op).toLowerCase()) {
                case 'mkdir': {
                    const a = await need(dest || src, writeRoots, 'New folder');
                    await fsp.mkdir(a, { recursive: true });
                    return { ok: true, mkdir: a };
                }
                case 'delete': {
                    const a = await need(src, writeRoots, 'Path');
                    const st = await fsp.stat(a);
                    await fsp.rm(a, { recursive: true, force: true });
                    return { ok: true, deleted: a, was: st.isDirectory() ? 'folder' : 'file' };
                }
                case 'rename': {
                    const a = await need(src, writeRoots, 'Source'), b = await need(dest, writeRoots, 'Destination');
                    await fsp.rename(a, b);
                    return { ok: true, from: a, to: b };
                }
                case 'move': {
                    const a = await need(src, readRoots, 'Source'), b = await need(dest, writeRoots, 'Destination');
                    await fsp.mkdir(path.dirname(b), { recursive: true });
                    try { await fsp.rename(a, b); }
                    catch (e) { await fsp.cp(a, b, { recursive: true }); await fsp.rm(a, { recursive: true, force: true }); }
                    return { ok: true, moved: a, to: b };
                }
                case 'copy': {
                    const a = await need(src, readRoots, 'Source'), b = await need(dest, writeRoots, 'Destination');
                    await fsp.mkdir(path.dirname(b), { recursive: true });
                    await fsp.cp(a, b, { recursive: true });
                    return { ok: true, copied: a, to: b };
                }
                default: throw new Error('Unknown op: ' + op);
            }
        }
    },
    {
        name: 'clipboard', risk: 'safe',
        description: 'Read or write the system clipboard. op="get" returns the current clipboard text; op="set" replaces it with the given text (handy for putting something ready to paste).',
        parameters: { type: 'object', properties: { op: { type: 'string', enum: ['get', 'set'] }, text: { type: 'string', description: 'Text to place on the clipboard (for set)' } }, required: ['op'] },
        run: async ({ op, text = '' }) => {
            if (op === 'get') {
                const r = await ps('[Console]::OutputEncoding=[Text.Encoding]::UTF8; $c=Get-Clipboard -Raw; if($null -ne $c){$c}else{""}', 10000);
                if (r.code !== 0) throw new Error('Could not read the clipboard: ' + (r.stderr || '').trim());
                return { text: String(r.stdout || '').replace(/\r?\n$/, '') };
            }
            const script = `$t=${b64Arg(toBase64(text))}; Set-Clipboard -Value $t; 'ok'`;
            const r = await ps(script, 10000);
            if (r.code !== 0) throw new Error('Could not write the clipboard: ' + (r.stderr || '').trim());
            return { set: true, chars: String(text).length };
        }
    },
    {
        name: 'list_processes', risk: 'safe',
        description: 'List the heaviest running processes (name, pid, memory MB, cpu seconds). Optionally filter by a name substring.',
        parameters: { type: 'object', properties: { filter: { type: 'string', description: 'Match processes whose name contains this (case-insensitive)' }, limit: { type: 'number', description: 'Max rows (default 20)' } } },
        run: async ({ filter, limit = 20 }) => {
            const N = Math.max(1, Math.min(Math.round(+limit || 20), 100));
            const script = `$f=${b64Arg(toBase64(filter || ''))};` +
                `$ps=Get-Process | Where-Object { $_.ProcessName };` +
                `if($f){$ps=$ps|Where-Object{$_.ProcessName -like ('*'+$f+'*')}};` +
                `$ps|Sort-Object WorkingSet64 -Descending|Select-Object -First ${N}` +
                ` @{n='name';e={$_.ProcessName}},@{n='pid';e={$_.Id}},@{n='memMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},@{n='cpuSec';e={[math]::Round($_.CPU,1)}}|ConvertTo-Json -Compress`;
            const rows = await psJson(script);
            return { count: rows.length, processes: rows };
        }
    },
    {
        name: 'kill_process', risk: 'dangerous',
        description: 'Stop a running program by pid or by process name. This forcibly closes it, so it always asks the user to confirm.',
        parameters: { type: 'object', properties: { pid: { type: 'number', description: 'Process id to stop' }, name: { type: 'string', description: 'Process name (without .exe), e.g. "notepad" — stops every instance' } } },
        run: async ({ pid, name }) => {
            const idNum = (pid != null && /^\d+$/.test(String(pid).trim())) ? parseInt(String(pid).trim(), 10) : null;
            let script, label;
            if (idNum) { script = `Stop-Process -Id ${idNum} -Force -ErrorAction Stop; 'ok'`; label = 'pid ' + idNum; }
            else if (name) { script = `$n=${b64Arg(toBase64(name))}; (Get-Process -Name $n -ErrorAction Stop)|Stop-Process -Force; 'ok'`; label = 'name ' + name; }
            else throw new Error('Provide either pid or name.');
            const r = await ps(script, 15000);
            if (r.code !== 0) throw new Error('Could not stop ' + label + ': ' + (r.stderr || '').trim());
            return { ok: true, stopped: label };
        }
    },
    {
        name: 'list_windows', risk: 'safe',
        description: 'List open application windows that have a visible title (name, pid, title). Use it to find a window, then activate_window to focus it.',
        parameters: { type: 'object', properties: {} },
        run: async () => {
            const rows = await psJson(`Get-Process | Where-Object { $_.MainWindowTitle }|Sort-Object ProcessName|` +
                `Select-Object @{n='name';e={$_.ProcessName}},@{n='pid';e={$_.Id}},@{n='title';e={$_.MainWindowTitle}}|ConvertTo-Json -Compress`);
            return { count: rows.length, windows: rows };
        }
    },
    {
        name: 'activate_window', risk: 'safe',
        description: 'Bring a running app/window to the foreground. Pass a pid (preferred) or a window-title fragment.',
        parameters: { type: 'object', properties: { pid: { type: 'number', description: 'Process id of the window to focus' }, title: { type: 'string', description: 'Window title (or leading fragment) to focus' } } },
        run: async ({ pid, title }) => {
            if (!IS_WIN) throw new Error('Window focus supports Windows only');
            let arg;
            if (pid != null && /^\d+$/.test(String(pid).trim())) arg = String(parseInt(String(pid).trim(), 10));
            else if (title) arg = b64Arg(toBase64(title));
            else throw new Error('Provide pid or title.');
            const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(${arg})|Out-Null; 'ok'`;
            const r = await ps(script, 10000);
            if (r.code !== 0) throw new Error('No matching window to focus: ' + (r.stderr || '').trim());
            return { focused: arg && !/^\d+$/.test(arg) ? 'title ' + title : 'pid ' + pid };
        }
    },
    {
        name: 'disk_usage', risk: 'safe',
        description: 'Report each drive’s used and free space in GB (and whether a path’s drive has room).',
        parameters: { type: 'object', properties: {} },
        run: async () => {
            const rows = await psJson(`Get-PSDrive -PSProvider FileSystem|` +
                `Where-Object { ($_.Used -ne $null -or $_.Free -ne $null) }|` +
                `Select-Object @{n='drive';e={$_.Name}},@{n='usedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='freeGB';e={[math]::Round($_.Free/1GB,1)}}|ConvertTo-Json -Compress`);
            rows.forEach(d => { if (/^[A-Za-z]$/.test(String(d.drive))) d.drive += ':'; });
            return { drives: rows };
        }
    },
    {
        name: 'web_search', risk: 'safe',
        description: 'Search the web and return the top results (title, url, snippet). Use it to find something, then open_url to visit a result or read_url to pull its text.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for' }, count: { type: 'number', description: 'How many results (default 8, max 10)' } }, required: ['query'] },
        run: async ({ query, count = 8 }) => {
            const N = Math.max(1, Math.min(Math.round(+count || 8), 10));
            const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
            let html = '';
            try {
                const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(String(query)), {
                    signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Majin/2.0)', accept: 'text/html' }
                });
                html = await r.text();
            } catch (e) {
                throw new Error('Search failed: ' + (e.name === 'AbortError' ? 'it timed out' : (e.message || String(e))));
            } finally { clearTimeout(timer); }
            const results = [];
            const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
            const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
            const snippets = []; let sm;
            while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]));
            let m;
            while ((m = linkRe.exec(html)) && results.length < N) {
                let url = m[1];
                try { const u = new URL(url.startsWith('//') ? 'https:' + url : url); url = decodeURIComponent(u.searchParams.get('uddg') || url); } catch (_) {}
                if (!/^https?:\/\//i.test(url)) continue;
                results.push({ title: stripTags(m[2]), url, snippet: snippets[results.length] || '' });
            }
            if (!results.length) return { query, results: [], note: 'No results could be parsed (the search page may have changed or blocked the request). Try rephrasing, or open a specific site with open_url.' };
            return { query, results };
        }
    },
    {
        name: 'screen_info', risk: 'safe',
        description: 'Report screen geometry — primary and virtual (all-monitors) pixel bounds plus each monitor. Call this before click/drag/scroll so coordinates are in range. Origin (0,0) is the top-left of the primary monitor; virtual bounds may start at negative x/y.',
        parameters: { type: 'object', properties: {} },
        run: async () => {
            const g = await screenGeometry();
            return { ...g, note: 'All values are physical pixels. Use virtual/monitor bounds to keep click targets on-screen.' };
        }
    },
    {
        name: 'ocr_screen', risk: 'safe',
        description: 'Read the text on the screen with the built-in Windows OCR engine and return each line with its bounding box AND a clickable center (cx,cy in absolute pixels). Works even for text-only models. Optionally pass a region [x,y,width,height] to read just part of the screen, or include_image=true to also attach the screenshot for a vision model.',
        parameters: {
            type: 'object', properties: {
                region: { type: 'array', items: { type: 'number' }, description: 'Optional [x, y, width, height] crop in pixels; omit for the whole screen' },
                include_image: { type: 'boolean', description: 'Also attach the captured image so a vision model can read it' }
            }
        },
        run: async ({ region, include_image = false }) => {
            let rect;
            if (Array.isArray(region) && region.length === 4) rect = { x: toInt(region[0]), y: toInt(region[1]), width: toInt(region[2]), height: toInt(region[3]) };
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                const g = await screenGeometry();
                rect = { x: g.virtual.x, y: g.virtual.y, width: g.virtual.width, height: g.virtual.height };
            }
            const file = await captureRegion(rect);
            let lines = [], imageB64 = null;
            try {
                if (include_image) imageB64 = (await fsp.readFile(file)).toString('base64');
                lines = await runOcrOnFile(file);
            } finally {
                await fsp.rm(file, { force: true }).catch(() => {});
            }
            const out = lines.map(l => {
                const x = rect.x + (l.x || 0), y = rect.y + (l.y || 0);
                return { text: l.text, x, y, w: l.w || 0, h: l.h || 0, cx: x + Math.floor((l.w || 0) / 2), cy: y + Math.floor((l.h || 0) / 2) };
            });
            const result = { region: rect, lineCount: out.length, lines: out.slice(0, 400), text: out.map(o => o.text).join('\n').slice(0, 20000), hint: 'cx/cy are absolute screen pixels — pass them straight to click.' };
            if (include_image) result._image = imageB64;
            return result;
        }
    },
    {
        name: 'move_mouse', risk: 'dangerous',
        description: 'Move the physical mouse cursor to absolute pixel coordinates (x,y). Part of Computer Use; ask the user to confirm and prefer ocr_screen to find target coordinates.',
        parameters: { type: 'object', properties: { x: { type: 'number', description: 'Absolute x pixel' }, y: { type: 'number', description: 'Absolute y pixel' } }, required: ['x', 'y'] },
        run: async ({ x, y }) => { const X = toInt(x), Y = toInt(y); await runInput(`[Inp]::Move(${X}, ${Y})`); return { moved: { x: X, y: Y } }; }
    },
    {
        name: 'click', risk: 'dangerous',
        description: 'Click at absolute screen pixels (x,y) with left|right|middle, single or double. The cursor is moved there first. Use ocr_screen (cx,cy) or screen_info for coordinates. Always user-confirmed.',
        parameters: {
            type: 'object', properties: {
                x: { type: 'number', description: 'Absolute x pixel' },
                y: { type: 'number', description: 'Absolute y pixel' },
                button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' },
                double: { type: 'boolean', description: 'Double-click instead of single' }
            }, required: ['x', 'y']
        },
        run: async ({ x, y, button = 'left', double = false }) => {
            const X = toInt(x), Y = toInt(y), b = safeButton(button), n = double ? 2 : 1;
            await runInput(`[Inp]::Move(${X}, ${Y}); [Inp]::Click("${b}", ${n})`);
            return { clicked: { x: X, y: Y, button: b, double: !!double } };
        }
    },
    {
        name: 'drag', risk: 'dangerous',
        description: 'Press-drag-release from (from_x,from_y) to (to_x,to_y) in absolute pixels — for selecting, moving windows, sliders. User-confirmed.',
        parameters: {
            type: 'object', properties: {
                from_x: { type: 'number' }, from_y: { type: 'number' },
                to_x: { type: 'number' }, to_y: { type: 'number' }
            }, required: ['from_x', 'from_y', 'to_x', 'to_y']
        },
        run: async ({ from_x, from_y, to_x, to_y }) => {
            const a = toInt(from_x), b = toInt(from_y), c = toInt(to_x), d = toInt(to_y);
            await runInput(`[Inp]::Drag(${a}, ${b}, ${c}, ${d})`);
            return { dragged: { from: { x: a, y: b }, to: { x: c, y: d } } };
        }
    },
    {
        name: 'scroll', risk: 'dangerous',
        description: 'Scroll the mouse wheel (direction up|down) by amount notches, optionally moving the cursor to (x,y) first so the right pane scrolls. User-confirmed.',
        parameters: {
            type: 'object', properties: {
                direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default down)' },
                amount: { type: 'number', description: 'Wheel notches (default 3)' },
                x: { type: 'number', description: 'Optional x to position cursor before scrolling' },
                y: { type: 'number', description: 'Optional y to position cursor before scrolling' }
            }
        },
        run: async ({ direction = 'down', amount = 3, x, y }) => {
            const notches = Math.max(-50, Math.min(50, toInt(amount)));
            const delta = (direction === 'up' ? -1 : 1) * notches * 120;
            let call = '';
            if (x != null && y != null) call += `[Inp]::Move(${toInt(x)}, ${toInt(y)}); `;
            call += `[Inp]::Wheel(${delta})`;
            await runInput(call);
            return { scrolled: notches, direction };
        }
    },
    {
        name: 'type_text', risk: 'dangerous',
        description: 'Type literal Unicode text into whatever window currently has keyboard focus (via SendInput, so symbols/space/newline work). Activate the target window first so it goes to the right place. User-confirmed.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to type' } }, required: ['text'] },
        run: async ({ text }) => {
            const t = String(text == null ? '' : text);
            if (!t) throw new Error('Nothing to type.');
            await runInput(`$t=${b64Arg(toBase64(t))}; [Inp]::Type($t)`, 20000);
            return { typed: true, chars: t.length };
        }
    },
    {
        name: 'press_keys', risk: 'dangerous',
        description: 'Press a key combo, e.g. "ctrl+s", "alt+tab", "win+d", "ctrl+shift+esc", "enter", "f5", "esc". Modifiers: ctrl, alt, shift, win. User-confirmed.',
        parameters: { type: 'object', properties: { combo: { type: 'string', description: 'Keys joined by +, e.g. ctrl+s' } }, required: ['combo'] },
        run: async ({ combo }) => {
            const c = String(combo || '').trim();
            if (!c) throw new Error('No key combination given.');
            if (!/^[A-Za-z0-9+<>^%\-\s]{1,40}$/.test(c)) throw new Error('Unsafe key combination: ' + c);
            await runInput(`$k=${b64Arg(toBase64(c))}; [Inp]::Combo($k)`);
            return { pressed: c };
        }
    },
    {
        name: 'index_files', risk: 'dangerous',
        description: 'Build/refresh Majin’s semantic memory by embedding text and source files under a folder (default ~/Documents) and sending those passages to the embedding provider. After this you can answer "find where I wrote about …". v1 reads text/code only (not PDF/DOCX/images). Re-running only replaces the chunks from that folder. Because it uploads file content, it asks the user to confirm first.',
        parameters: {
            type: 'object', properties: {
                path: { type: 'string', description: 'Folder to index (default ~/Documents). Must be inside the allowed roots.' },
                limit: { type: 'number', description: 'Max files to process (default 300)' }
            }
        },
        run: async ({ path: p, limit = 300 }, ctx) => {
            const root = await resolveWithinJail(expandHome(p || '~/Documents'), allowedRoots().concat(systemRoots()), 'Index folder');
            const cap = Math.max(1, Math.min(toInt(limit) || 300, 2000));
            const files = [];
            await walkInto(root, files, cap);
            const pending = [], meta = [];
            for (const f of files) {
                const text = await extractText(f.p).catch(() => null);
                if (!text) continue;
                for (const c of chunkText(text)) { pending.push(c); meta.push({ file: f.p, mtime: f.mtime }); if (pending.length >= 4000) break; }
                if (pending.length >= 4000) break;
            }
            if (!pending.length) return { ok: true, root, filesIndexed: 0, note: 'No indexable text/code files found under that folder (v1 skips PDF/DOCX/binary).' };
            const vectors = await embedText(pending);
            const built = pending.map((t, i) => ({ file: meta[i].file, mtime: meta[i].mtime, text: t, vec: vectors[i] }));
            const mem = await loadMemory();
            const keep = mem.chunks.filter(c => !withinJail(path.resolve(c.file), [root]));
            mem.chunks = keep.concat(built);
            await saveMemory(mem);
            (ctx && ctx.emit || (() => {}))({ type: 'workspace', title: 'Memory index updated', blocks: [{ type: 'keyvalue', pairs: [{ key: 'Folder', value: root }, { key: 'Files indexed', value: String(files.length) }, { key: 'Passages stored', value: String(built.length) }] }, { type: 'callout', tone: 'success', body: 'Now ask me to find where you wrote about something.' }] });
            return { ok: true, root, filesIndexed: files.length, passagesStored: built.length };
        }
    },
    {
        name: 'memory_search', risk: 'safe',
        description: 'Semantically search the indexed memory for the passages most relevant to a question, returning the source file and snippet. Needs index_files run first.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, in natural language' }, topK: { type: 'number', description: 'How many passages (default 6)' } }, required: ['query'] },
        run: async ({ query, topK = 6 }) => {
            const mem = await loadMemory();
            if (!mem.chunks.length) return { error: 'Memory index is empty — run index_files on a folder first.' };
            const qv = (await embedText([String(query || '')]))[0];
            const topK2 = Math.max(1, Math.min(toInt(topK) || 6, 25));
            const scored = mem.chunks.map(c => ({ file: c.file, text: c.text, score: cosine(qv, c.vec) }))
                .sort((a, b) => b.score - a.score).slice(0, topK2);
            return { query, results: scored.map(s => ({ file: s.file, snippet: String(s.text || '').slice(0, 600), score: +s.score.toFixed(3) })) };
        }
    },
    {
        name: 'memory_stats', risk: 'safe',
        description: 'Report what Majin’s semantic memory currently holds (passage count, distinct files, storage location).',
        parameters: { type: 'object', properties: {} },
        run: async () => {
            const mem = await loadMemory();
            const files = new Set(mem.chunks.map(c => c.file));
            return { passages: mem.chunks.length, files: files.size, location: MEMORY_FILE, roots: [...files].slice(0, 20) };
        }
    },
    {
        name: 'memory_forget', risk: 'dangerous',
        description: 'Drop indexed memory — pass a folder to forget only that subtree’s passages, or nothing to clear the whole index. User-confirmed.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder to forget; omit to clear everything' } } },
        run: async ({ path: p }) => {
            const mem = await loadMemory();
            if (p) {
                const root = path.resolve(expandHome(p));
                const before = mem.chunks.length;
                mem.chunks = mem.chunks.filter(c => !withinJail(path.resolve(c.file), [root]));
                await saveMemory(mem);
                return { removed: before - mem.chunks.length, remaining: mem.chunks.length, under: root };
            }
            const n = mem.chunks.length; mem.chunks = []; await saveMemory(mem);
            return { cleared: n };
        }
    }
];

/* ---------- home expansion + broad read roots ---------- */
function expandHome(p) {
    const s = String(p || '');
    if (s === '~') return os.homedir();
    if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
    return s;
}
function systemRoots() {
    // Read-only broad access to common code locations. Deliberately does NOT include the
    // bare home directory (that would expose ~/.ssh, ~/.aws, browser profiles, etc.); only
    // specific project/code folders. Never used for writes.
    const home = os.homedir();
    return [path.join(home, 'PycharmProjects'), path.join(home, 'projects'), path.join(process.cwd())];
}

/* ---------- reminder scheduling (server broadcasts these to every open window) ---------- */
let broadcast = () => {};
// The server installs this once, at boot: it fans an event out to all live streams.
export function setBroadcast(fn) { broadcast = fn; }
export async function startReminderScheduler() {
    for (const r of await loadReminders()) schedule(r.id, r.text, r.when);
}
const timers = new Map();
function schedule(id, text, when) {
    const delay = Math.max(1000, when - Date.now());
    if (timers.has(id)) clearTimeout(timers.get(id));
    timers.set(id, setTimeout(async () => {
        timers.delete(id);
        broadcast({ type: 'reminder', text });
        await windowsToast('Majin reminder', text).catch(() => {});
        const list = await loadReminders();
        await saveReminders(list.filter(r => r.id !== id));
    }, delay));
}

/* =========================================================================
   Auto-Workspace — turn read-tool results into rich blocks so the Workspace
   fills on its own, without the model having to call show_blocks. Returns
   {title, blocks} or null. Never throws: the agent loop must not depend on it.
   ========================================================================= */
function numUnit(str) {
    const s = String(str == null ? '' : str).trim();
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
    return m ? { value: m[1], unit: m[2] } : { value: s, unit: '' };
}
export function workspaceFromTool(name, result) {
    if (!result || typeof result !== 'object' || result.error || result._image) return null;
    const num = v => (typeof v === 'number' ? String(v) : numUnit(v));
    try {
        switch (name) {
            case 'system_info': {
                if (!result.platform && !result.totalMem) return null;
                const mem = numUnit(result.freeMem), tot = numUnit(result.totalMem);
                const stats = [
                    { label: 'Free memory', ...mem, tone: 'success' },
                    { label: 'Total memory', ...tot },
                    { label: 'CPU cores', value: String(result.cpus || ''), unit: 'cores' },
                    { label: 'Load avg', value: result.load ? String(result.load[0]) : '', unit: '' }
                ].filter(s => s.value && s.value !== 'NaN');
                const kv = [['Platform', result.platform], ['Host', result.hostname], ['CPU', result.cpuModel],
                    ['Uptime', result.uptime], ['Node', result.node], ['Home', result.home], ['Battery', result.battery]]
                    .filter(p => p[1]).map(p => ({ key: p[0], value: String(p[1]) }));
                return { title: 'System status', blocks: [{ type: 'hero', title: 'System status', body: `${result.platform || ''} · ${result.hostname || ''}`, tone: 'info' }, { type: 'metrics', stats }, { type: 'keyvalue', title: 'Details', pairs: kv }] };
            }
            case 'disk_usage': {
                const drives = Array.isArray(result.drives) ? result.drives : [];
                if (!drives.length) return null;
                const bars = drives.slice(0, 8).map(d => ({ label: d.drive, value: String(d.usedGB), max: String(Math.max(0.0001, (d.usedGB || 0) + (d.freeGB || 0))), unit: 'GB', tone: (d.freeGB != null && d.freeGB < 20 ? 'danger' : 'info') }));
                return { title: 'Storage', blocks: [{ type: 'hero', title: 'Storage', body: `${drives.length} drive${drives.length > 1 ? 's' : ''} in use`, tone: 'info' }, { type: 'progress', title: 'Used space per drive', bars }] };
            }
            case 'list_processes': {
                const procs = Array.isArray(result.processes) ? result.processes : [];
                if (!procs.length) return null;
                const top = procs.slice(0, 8);
                const maxMem = Math.max(1, ...procs.map(p => +p.memMB || 0));
                return { title: 'Processes', blocks: [
                    { type: 'metrics', stats: [{ label: 'Showing', value: String(procs.length), unit: 'procs' }, { label: 'Busiest', value: top[0] ? String(top[0].memMB) : '', unit: 'MB', tone: 'warn' }] },
                    { type: 'progress', title: 'Top by memory', bars: top.map(p => ({ label: `${p.name} #${p.pid}`, value: String(p.memMB), max: String(maxMem), unit: 'MB' })) },
                    { type: 'table', title: 'All rows', table: { headers: ['Name', 'PID', 'Mem MB', 'CPU s'], rows: procs.slice(0, 20).map(p => [String(p.name), String(p.pid), String(p.memMB), String(p.cpuSec)]) } }
                ] };
            }
            case 'list_windows': {
                const wins = Array.isArray(result.windows) ? result.windows : [];
                if (!wins.length) return null;
                return { title: 'Open windows', blocks: [{ type: 'metrics', stats: [{ label: 'Windows', value: String(wins.length), unit: 'open' }] }, { type: 'list', title: 'Titles', items: wins.slice(0, 25).map(w => `**${w.name}** — ${w.title} (#${w.pid})`) }] };
            }
            case 'list_reminders': {
                const rem = Array.isArray(result.reminders) ? result.reminders : [];
                return { title: 'Reminders', blocks: rem.length ? [{ type: 'timeline', title: 'Upcoming', items: rem.map(r => `${r.fires} — ${r.text}`) }] : [{ type: 'callout', tone: 'info', body: 'No pending reminders.' }] };
            }
            case 'screen_info': {
                if (!result.primary) return null;
                const mons = Array.isArray(result.monitors) ? result.monitors : [];
                return { title: 'Screen', blocks: [
                    { type: 'metrics', stats: [{ label: 'Primary', value: String(result.primary.width), unit: `× ${result.primary.height}` }, { label: 'Virtual', value: String(result.virtual.width), unit: `× ${result.virtual.height}` }, { label: 'Monitors', value: String(mons.length), unit: '' }] },
                    { type: 'chips', items: mons.map(m => `${m.x},${m.y} ${m.width}×${m.height}${m.primary ? ' ★' : ''}`) }
                ] };
            }
            case 'ocr_screen': {
                const lines = Array.isArray(result.lines) ? result.lines : [];
                if (!lines.length) return null;
                return { title: 'On-screen text', blocks: [{ type: 'metrics', stats: [{ label: 'Lines read', value: String(result.lineCount || lines.length), unit: '', tone: 'success' }] }, { type: 'list', items: lines.slice(0, 18).map(l => l.text) }] };
            }
            case 'memory_stats': {
                return { title: 'Memory', blocks: [{ type: 'metrics', stats: [{ label: 'Passages', value: String(result.passages || ''), unit: '' }, { label: 'Files', value: String(result.files || ''), unit: '' }] }] };
            }
            case 'web_search': {
                const rs = Array.isArray(result.results) ? result.results : [];
                if (!rs.length) return null;
                return { title: `Web · ${result.query || ''}`, blocks: rs.slice(0, 8).map(r => ({ type: 'text', body: `**[${r.title}](${r.url})**  \n${r.snippet || ''}` })) };
            }
            default: return null;
        }
    } catch (e) { return null; }
}

export function isDangerous(tool, args) {
    if (tool.risk === 'dangerous') return true;
    if (typeof tool.dangerousWhen === 'function') { try { return !!tool.dangerousWhen(args || {}); } catch (e) { return false; } }
    return false;
}

/* pure helpers — exported for unit tests (no server boot, no side effects) */
export { withinJail, expandHome, allowedRoots, systemRoots, commandIsDangerous };

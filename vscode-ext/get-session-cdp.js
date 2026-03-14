/**
 * Get sessionKey + usage from Chrome via CDP (browser-level connection).
 * Captures sessionKey from Set-Cookie across ALL tabs/popups — works with
 * regular login, Apple/iCloud SSO, Google SSO, etc.
 * If already logged in: reads cookie directly + fetches usage.
 * If not logged in: waits for Set-Cookie on any tab/popup, then fetches usage.
 * Usage: node get-session-cdp.js <profileDir> <accountName>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const CHROME_EXE = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].find(p => fs.existsSync(p));

const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const JUNCTION_PATH = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'ChromeDebug');
const profileDir = process.argv[2] || 'Default';
const accountName = process.argv[3];
const LOGIN_TIMEOUT_MS = 180000;

if (!CHROME_EXE) { console.log(JSON.stringify({ error: 'Chrome not found' })); process.exit(1); }

function createJunction() {
    try { fs.lstatSync(JUNCTION_PATH); return; } catch {}
    try { execSync(`mklink /J "${JUNCTION_PATH}" "${CHROME_USER_DATA}"`, { shell: 'cmd.exe', stdio: 'ignore' }); } catch {}
}

function wsSend(sock, data) {
    const msg = Buffer.from(JSON.stringify(data));
    const mask = crypto.randomBytes(4);
    let hdr;
    if (msg.length < 126) {
        hdr = Buffer.alloc(6);
        hdr[0] = 0x81; hdr[1] = 0x80 | msg.length;
        mask.copy(hdr, 2);
    } else {
        hdr = Buffer.alloc(8);
        hdr[0] = 0x81; hdr[1] = 0x80 | 126;
        hdr.writeUInt16BE(msg.length, 2);
        mask.copy(hdr, 4);
    }
    const body = Buffer.alloc(msg.length);
    for (let i = 0; i < msg.length; i++) body[i] = msg[i] ^ mask[i % 4];
    sock.write(Buffer.concat([hdr, body]));
}

function parseFrames(buf, cb) {
    while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        try { cb(JSON.parse(buf.slice(off, off + len).toString())); } catch {}
        buf = buf.slice(off + len);
    }
    return buf;
}

function parseSetCookieSessionKey(sc) {
    if (!sc) return null;
    for (const h of Array.isArray(sc) ? sc : [sc]) {
        const m = h.match(/(?:^|;\s*)sessionKey=([^;]+)/i);
        if (m) return m[1].trim();
    }
    return null;
}

async function getVersion(port) {
    return new Promise((res, rej) =>
        http.get(`http://localhost:${port}/json/version`, { timeout: 3000 }, (r) => {
            let b = ''; r.on('data', d => b += d);
            r.on('end', () => { try { res(JSON.parse(b)); } catch { rej(new Error('bad json')); } });
        }).on('error', rej)
    );
}

// Browser-level CDP session — sees all tabs and popups
async function cdpBrowserSession(port) {
    const version = await getVersion(port);
    const wsUrl = version.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('no browser WS URL');

    return new Promise((resolve) => {
        const url = new URL(wsUrl);
        const sock = net.connect(port, '127.0.0.1');
        const wk = crypto.randomBytes(16).toString('base64');
        let up = false, buf = Buffer.alloc(0), done = false;
        let cmdId = 1;

        const sessions = {}; // sessionId → targetInfo
        let sessionKey = null, usage = null;
        let claudeTabSessionId = null;
        let cookiesRequested = false, evalRequested = false, evalDone = false;
        let waitingForLogin = false;

        const COOKIES_ID = 100, EVAL_ID = 200;

        const finish = (result) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch {}
            resolve(result);
        };

        const globalTimer = setTimeout(() => {
            finish({ sessionKey, usage, error: sessionKey ? null : 'timeout - not logged in' });
        }, LOGIN_TIMEOUT_MS);

        const send = (method, params, id, sessionId) => {
            const msg = { id: id || cmdId++, method, params };
            if (sessionId) msg.sessionId = sessionId;
            wsSend(sock, msg);
        };

        const requestCookies = (sessionId) => {
            if (cookiesRequested) return;
            cookiesRequested = true;
            claudeTabSessionId = sessionId;
            send('Network.getAllCookies', {}, COOKIES_ID, sessionId);
        };

        const requestEval = (sessionId) => {
            if (evalRequested) return;
            evalRequested = true;
            const sid = sessionId || claudeTabSessionId;
            if (!sid) return;
            const expr = `(async()=>{try{
                const o=await fetch('/api/organizations',{credentials:'include'}).then(r=>r.json());
                if(!Array.isArray(o)||!o[0])return JSON.stringify({error:'no orgs'});
                const id=o[0].uuid||o[0].id;
                const u=await fetch('/api/organizations/'+id+'/usage',{credentials:'include'}).then(r=>r.json());
                return JSON.stringify(u);
            }catch(e){return JSON.stringify({error:e.message});}})()`;
            send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 }, EVAL_ID, sid);
        };

        const attachTarget = (sessionId, targetInfo) => {
            sessions[sessionId] = targetInfo;
            if (targetInfo.type !== 'page' && targetInfo.type !== 'popup') return;
            send('Network.enable', {}, null, sessionId);
            if (targetInfo.url && targetInfo.url.includes('claude.ai')) {
                setTimeout(() => requestCookies(sessionId), 600);
            }
        };

        sock.setTimeout(LOGIN_TIMEOUT_MS + 5000, () => finish({ error: 'socket timeout' }));
        sock.on('error', e => finish({ error: 'socket: ' + e.message }));

        sock.on('connect', () => sock.write(
            `GET ${url.pathname} HTTP/1.1\r\nHost:${url.host}\r\n` +
            `Upgrade:websocket\r\nConnection:Upgrade\r\n` +
            `Sec-WebSocket-Key:${wk}\r\nSec-WebSocket-Version:13\r\n\r\n`
        ));

        sock.on('data', (ch) => {
            if (!up) {
                if (ch.toString().includes('101')) {
                    up = true;
                    const i = ch.indexOf('\r\n\r\n');
                    buf = i !== -1 ? ch.slice(i + 4) : Buffer.alloc(0);
                    // Auto-attach to ALL targets including popups
                    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
                }
                return;
            }

            buf = parseFrames(Buffer.concat([buf, ch]), (m) => {
                // New target attached (tab opened, popup opened, etc.)
                if (m.method === 'Target.attachedToTarget') {
                    attachTarget(m.params.sessionId, m.params.targetInfo);
                }

                // Target navigated — update sessionId→url mapping
                if (m.method === 'Target.targetInfoChanged') {
                    const { targetId, url: newUrl } = m.params.targetInfo;
                    const entry = Object.entries(sessions).find(([, t]) => t.targetId === targetId);
                    if (entry) {
                        sessions[entry[0]].url = newUrl;
                        // If this tab just navigated to claude.ai, request cookies
                        if (newUrl && newUrl.includes('claude.ai') && !cookiesRequested) {
                            setTimeout(() => requestCookies(entry[0]), 800);
                        }
                    }
                }

                // Network.getAllCookies response
                if (m.id === COOKIES_ID) {
                    const cookies = m.result && m.result.cookies;
                    if (cookies) {
                        const sk = cookies.find(c => c.name === 'sessionKey' && c.domain.includes('claude'));
                        if (sk) {
                            sessionKey = sk.value;
                            clearTimeout(globalTimer);
                            requestEval(claudeTabSessionId);
                        } else {
                            waitingForLogin = true;
                        }
                    } else {
                        waitingForLogin = true;
                    }
                }

                // Runtime.evaluate response
                if (m.id === EVAL_ID) {
                    try {
                        const val = m.result && m.result.result && m.result.result.value;
                        if (val) {
                            const parsed = typeof val === 'string' ? JSON.parse(val) : val;
                            if (parsed && !parsed.error) usage = parsed;
                        }
                    } catch {}
                    evalDone = true;
                    clearTimeout(globalTimer);
                    finish({ sessionKey, usage });
                }

                // Set-Cookie on ANY tab/popup — catches SSO redirects
                if (waitingForLogin && m.method === 'Network.responseReceivedExtraInfo') {
                    const headers = m.params && m.params.headers;
                    if (headers) {
                        const sc = headers['set-cookie'] || headers['Set-Cookie'] ||
                            Object.entries(headers).find(([k]) => k.toLowerCase() === 'set-cookie')?.[1];
                        const sk = parseSetCookieSessionKey(sc);
                        if (sk) {
                            sessionKey = sk;
                            waitingForLogin = false;
                            clearTimeout(globalTimer);
                            // Find claude.ai tab session for eval
                            const claudeEntry = Object.entries(sessions).find(([, t]) => t.url && t.url.includes('claude.ai'));
                            setTimeout(() => requestEval(claudeEntry ? claudeEntry[0] : claudeTabSessionId), 2000);
                        }
                    }
                }
            });
        });
    });
}

async function run() {
    createJunction();
    try { execSync('taskkill /F /IM chrome.exe /T', { shell: 'cmd.exe', stdio: 'ignore', timeout: 3000 }); } catch {}
    await new Promise(r => setTimeout(r, 1000));

    const child = spawn(CHROME_EXE, [
        `--user-data-dir=${JUNCTION_PATH}`,
        `--profile-directory=${profileDir}`,
        '--remote-debugging-port=9223',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        'https://claude.ai'
    ], { stdio: 'ignore', shell: false });
    child.unref();
    child.on('error', e => { console.log(JSON.stringify({ error: 'spawn: ' + e.message })); process.exit(1); });

    await new Promise(r => setTimeout(r, 4000));

    let result;
    try {
        result = await cdpBrowserSession(9223);
    } catch (e) {
        console.log(JSON.stringify({ error: 'CDP: ' + e.message }));
        try { child.kill(); } catch {}
        return;
    }

    if (result.sessionKey && accountName) {
        const ACCOUNTS_DIR = path.join(os.homedir(), '.claude', 'accounts');
        const widgetFile = path.join(ACCOUNTS_DIR, `${accountName}.widget.json`);
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(widgetFile, 'utf8')); } catch {}
        existing.sessionKey = result.sessionKey;
        if (result.usage) existing.usage = result.usage;
        fs.writeFileSync(widgetFile, JSON.stringify(existing, null, 2), 'utf8');
    }

    const out = (result.error && !result.sessionKey)
        ? { error: result.error }
        : { sessionKey: result.sessionKey, ...(result.usage ? { usage: result.usage } : {}) };

    console.log(JSON.stringify(out));
}

run().catch(e => console.log(JSON.stringify({ error: e.message })));

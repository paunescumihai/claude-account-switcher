/**
 * Wait for user to log in on claude.ai via CDP, then capture sessionKey.
 * Chrome opens logged-out (App-Bound Encryption prevents loading old cookies).
 * We intercept the sessionKey from Set-Cookie response headers on login.
 * Usage: node get-session-cdp.js <profileDir> <accountName>
 * Output: JSON { sessionKey: "..." } or { error: "..." }
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
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));

const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const JUNCTION_PATH = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'ChromeDebug');

const profileDir = process.argv[2] || 'Default';
const accountName = process.argv[3];
const TIMEOUT_MS = 180000; // 3 minutes for user to log in

if (!CHROME_EXE) {
    console.log(JSON.stringify({ error: 'Chrome not found' }));
    process.exit(1);
}

function createJunction() {
    try {
        fs.lstatSync(JUNCTION_PATH);
        return; // already exists
    } catch {}
    try {
        execSync(`mklink /J "${JUNCTION_PATH}" "${CHROME_USER_DATA}"`, { shell: 'cmd.exe', stdio: 'ignore' });
    } catch {}
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

// Extract sessionKey from Set-Cookie header value
function parseSetCookieSessionKey(setCookieHeader) {
    if (!setCookieHeader) return null;
    // Handle array of Set-Cookie or single string
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const h of headers) {
        const m = h.match(/(?:^|;\s*)sessionKey=([^;]+)/i);
        if (m) return m[1].trim();
    }
    return null;
}

async function connectCDP(port) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/json/list`, { timeout: 3000 }, (res) => {
            let b = '';
            res.on('data', d => b += d);
            res.on('end', () => {
                try { resolve(JSON.parse(b)); }
                catch { reject(new Error('bad json')); }
            });
        });
        req.on('error', reject);
    });
}

async function run() {
    createJunction();

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
    child.on('error', e => {
        console.log(JSON.stringify({ error: 'spawn: ' + e.message }));
        process.exit(1);
    });

    // Wait for Chrome to start
    await new Promise(r => setTimeout(r, 4000));

    // Get tab list
    let tabs;
    try { tabs = await connectCDP(9223); }
    catch { console.log(JSON.stringify({ error: 'CDP not ready' })); child.kill(); return; }

    const tab = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!tab) { console.log(JSON.stringify({ error: 'no page tab' })); child.kill(); return; }

    const sessionKey = await new Promise((resolve) => {
        const wsPath = new URL(tab.webSocketDebuggerUrl).pathname;
        const sock = net.connect(9223, '127.0.0.1');
        const wk = crypto.randomBytes(16).toString('base64');
        let up = false, buf = Buffer.alloc(0);
        let cmdId = 1;
        let done = false;

        const finish = (val) => {
            if (done) return;
            done = true;
            sock.destroy();
            resolve(val);
        };

        // Global timeout
        const globalTimer = setTimeout(() => finish(null), TIMEOUT_MS);

        sock.setTimeout(TIMEOUT_MS + 5000, () => finish(null));
        sock.on('error', () => finish(null));
        sock.on('connect', () => sock.write(
            `GET ${wsPath} HTTP/1.1\r\nHost:127.0.0.1:9223\r\nUpgrade:websocket\r\n` +
            `Connection:Upgrade\r\nSec-WebSocket-Key:${wk}\r\nSec-WebSocket-Version:13\r\n\r\n`
        ));

        sock.on('data', (ch) => {
            if (!up) {
                if (ch.toString().includes('101')) {
                    up = true;
                    const i = ch.indexOf('\r\n\r\n');
                    buf = i !== -1 ? ch.slice(i + 4) : Buffer.alloc(0);
                    // Enable Network domain to intercept response headers (including Set-Cookie)
                    wsSend(sock, { id: cmdId++, method: 'Network.enable' });
                }
                return;
            }
            buf = parseFrames(Buffer.concat([buf, ch]), (m) => {
                if (m.method === 'Network.responseReceivedExtraInfo') {
                    // This event contains raw response headers including Set-Cookie
                    const headers = m.params && m.params.headers;
                    if (!headers) return;

                    // Headers object keys can be any case
                    const setCookie = headers['set-cookie'] || headers['Set-Cookie'] ||
                        Object.entries(headers).find(([k]) => k.toLowerCase() === 'set-cookie')?.[1];

                    const sk = parseSetCookieSessionKey(setCookie);
                    if (sk) {
                        clearTimeout(globalTimer);
                        finish(sk);
                    }
                }
            });
        });
    });

    try { child.kill(); } catch {}

    if (sessionKey && accountName) {
        const ACCOUNTS_DIR = path.join(os.homedir(), '.claude', 'accounts');
        const widgetFile = path.join(ACCOUNTS_DIR, `${accountName}.widget.json`);
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(widgetFile, 'utf8')); } catch {}
        existing.sessionKey = sessionKey;
        fs.writeFileSync(widgetFile, JSON.stringify(existing, null, 2), 'utf8');
    }

    console.log(JSON.stringify(sessionKey ? { sessionKey } : { error: 'timeout - login not detected' }));
}

run().catch(e => console.log(JSON.stringify({ error: e.message })));

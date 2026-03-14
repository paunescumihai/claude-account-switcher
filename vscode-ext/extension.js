const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const ACCOUNTS_DIR  = path.join(os.homedir(), '.claude', 'accounts');
const ACTIVE_FILE   = path.join(ACCOUNTS_DIR, '.active');
const CREDS_FILE    = path.join(os.homedir(), '.claude', '.credentials.json');
const VS_SETTINGS   = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
const LOCAL_STATE   = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State');
const WIDGET_STORE  = path.join(os.homedir(), 'AppData', 'Roaming', 'claude-usage-widget', 'config.json');
const WIDGET_DIR    = path.join(os.homedir(), 'claude-usage-widget-app');
const ELECTRON_EXE  = path.join(WIDGET_DIR, 'node_modules', '.bin', 'electron.cmd');
const CHROME_EXE      = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const BASE_DEBUG_PORT = 9222;

// ── Port management per account ──────────────────────────────────────────────

function getAccountPort(name) {
    const portFile = path.join(ACCOUNTS_DIR, `${name}.port`);
    try { return parseInt(fs.readFileSync(portFile, 'utf8').trim()); } catch { return null; }
}

function setAccountPort(name, port) {
    fs.writeFileSync(path.join(ACCOUNTS_DIR, `${name}.port`), String(port), 'utf8');
}

function allocatePort(name) {
    const existing = getAccountPort(name);
    if (existing) return existing;
    // Find next available port
    const usedPorts = new Set();
    try {
        fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.port')).forEach(f => {
            try { usedPorts.add(parseInt(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf8').trim())); } catch {}
        });
    } catch {}
    let port = BASE_DEBUG_PORT;
    while (usedPorts.has(port)) port++;
    setAccountPort(name, port);
    return port;
}

// ── Junction per account (Chrome needs different user-data-dir for CDP) ──────

function getJunctionPath(name) {
    return path.join(os.homedir(), 'AppData', 'Local', 'Google', `ChromeDebug_${name.replace(/[^a-zA-Z0-9]/g, '_')}`);
}

function ensureJunction(name) {
    const jPath = getJunctionPath(name);
    try { fs.lstatSync(jPath); return jPath; } catch {}
    try {
        require('child_process').execSync(`mklink /J "${jPath}" "${CHROME_USER_DATA}"`, { shell: 'cmd.exe', stdio: 'ignore' });
    } catch {}
    return jPath;
}

// ── Chrome profile helpers ───────────────────────────────────────────────────

function createChromeProfile(profileName, email = '') {
    let dirName = 'Profile 1';
    let n = 1;
    while (fs.existsSync(path.join(CHROME_USER_DATA, dirName))) {
        n++;
        dirName = `Profile ${n}`;
    }
    const profilePath = path.join(CHROME_USER_DATA, dirName);
    fs.mkdirSync(profilePath, { recursive: true });
    const prefs = {
        profile: { name: profileName, is_using_default_name: false, user_name: email }
    };
    fs.writeFileSync(path.join(profilePath, 'Preferences'), JSON.stringify(prefs, null, 2), 'utf8');
    try {
        const ls = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
        if (!ls.profile) ls.profile = {};
        if (!ls.profile.info_cache) ls.profile.info_cache = {};
        ls.profile.info_cache[dirName] = {
            name: profileName, is_using_default_name: false, user_name: email, active_time: Date.now() / 1000
        };
        fs.writeFileSync(LOCAL_STATE, JSON.stringify(ls), 'utf8');
    } catch {}
    return dirName;
}

function getChromeProfiles() {
    try {
        const data = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
        const cache = data.profile.info_cache;
        return Object.entries(cache).map(([dir, info]) => ({
            dir, name: info.name || dir, email: info.user_name || ''
        }));
    } catch { return []; }
}

// ── Status bar ───────────────────────────────────────────────────────────────

let statusBarItem;
let lastUsage = null;
let lastUsageTime = null;
let usageRefreshTimer = null;

function getActive() {
    try { return fs.readFileSync(ACTIVE_FILE, 'utf8').trim(); } catch { return null; }
}

function getAccounts() {
    try {
        return fs.readdirSync(ACCOUNTS_DIR)
            .filter(f => f.endsWith('.json') && !f.endsWith('.widget.json'))
            .map(f => f.replace('.json', ''));
    } catch { return []; }
}

function formatUsage(u) {
    if (!u) return null;
    const pct = u.utilization !== undefined ? Math.round(u.utilization) : null;
    const reset = u.resets_at ? new Date(u.resets_at) : null;
    const resetStr = reset ? reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return { pct, resetStr };
}

function buildTooltip(name, usageData) {
    if (!usageData || !usageData.usage) return 'Click pentru switch / adauga cont Claude';
    const u = usageData.usage;
    const lines = [`Claude: ${name || 'necunoscut'}`];
    if (u.five_hour) {
        const f = formatUsage(u.five_hour);
        lines.push(`  5h:  ${f.pct ?? '?'}%${f.resetStr ? ' (reset ' + f.resetStr + ')' : ''}`);
    }
    if (u.seven_day) {
        const s = formatUsage(u.seven_day);
        lines.push(`  7d:  ${s.pct ?? '?'}%${s.resetStr ? ' (reset ' + s.resetStr + ')' : ''}`);
    }
    if (u.seven_day_sonnet) {
        const sn = formatUsage(u.seven_day_sonnet);
        if (sn.pct !== null) lines.push(`  Sonnet: ${sn.pct}%`);
    }
    if (u.seven_day_opus) {
        const op = formatUsage(u.seven_day_opus);
        if (op.pct !== null) lines.push(`  Opus:   ${op.pct}%`);
    }
    if (lastUsageTime) lines.push(`  Actualizat: ${lastUsageTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    return lines.join('\n');
}

function updateStatusBar(usageData) {
    if (usageData !== undefined) { lastUsage = usageData; lastUsageTime = new Date(); }
    const active = getActive();
    const u = lastUsage && lastUsage.usage;
    const fivePct = u && u.five_hour && u.five_hour.utilization !== undefined
        ? Math.round(u.five_hour.utilization) : null;
    statusBarItem.text = fivePct !== null
        ? `$(account) ${active || 'Claude'} ${fivePct}%`
        : `$(account) ${active || 'Claude'}`;
    statusBarItem.tooltip = buildTooltip(active, lastUsage);
}

function updateVSCodeTitle(name) {
    try {
        const s = JSON.parse(fs.readFileSync(VS_SETTINGS, 'utf8'));
        s['window.title'] = `${name} | \${activeEditorShort}\${separator}\${rootName}`;
        fs.writeFileSync(VS_SETTINGS, JSON.stringify(s, null, 4), 'utf8');
    } catch {}
}

// ── Chrome CDP helpers ───────────────────────────────────────────────────────

function isPortListening(port) {
    return new Promise((resolve) => {
        const http = require('http');
        http.get(`http://localhost:${port}/json/version`, { timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => resolve(true));
        }).on('error', () => resolve(false));
    });
}

function launchChromeWithDebug(accountName, profileDir, port) {
    if (!CHROME_EXE) return;
    const jPath = ensureJunction(accountName);
    const { spawn } = require('child_process');
    const args = [
        `--user-data-dir=${jPath}`,
        `--profile-directory=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        'https://claude.ai'
    ];
    const child = spawn(CHROME_EXE, args, { stdio: 'ignore', shell: false });
    child.unref();
}

async function ensureChromeDebug(accountName, profileDir, port) {
    if (!CHROME_EXE) return false;
    // Already running on this port?
    if (await isPortListening(port)) return true;
    // Launch Chrome with debug port (no kill - each account has its own junction+port)
    launchChromeWithDebug(accountName, profileDir, port);
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isPortListening(port)) return true;
    }
    return false;
}

function openChrome(accountName, profileDir) {
    if (!CHROME_EXE) return;
    const port = allocatePort(accountName);
    ensureChromeDebug(accountName, profileDir, port);
}

function cdpRefreshUsage(port) {
    return new Promise((resolve) => {
        const http = require('http');
        const net = require('net');
        const crypto = require('crypto');

        http.get(`http://localhost:${port}/json/list`, { timeout: 3000 }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try {
                    const tabs = JSON.parse(body);
                    const claudeTab = tabs.find(t => t.url && t.url.includes('claude.ai') && t.webSocketDebuggerUrl);
                    const anyTab = tabs.find(t => t.webSocketDebuggerUrl);
                    const tab = claudeTab || anyTab;
                    if (!tab) { resolve({ error: 'no claude.ai tab found' }); return; }

                    const wsUrl = new URL(tab.webSocketDebuggerUrl);
                    const wsKey = crypto.randomBytes(16).toString('base64');
                    const sock = net.connect(parseInt(wsUrl.port) || port, wsUrl.hostname);
                    sock.setTimeout(15000);
                    sock.on('timeout', () => { sock.destroy(); resolve({ error: 'timeout' }); });
                    sock.on('error', (e) => resolve({ error: e.message }));

                    let upgraded = false;
                    let buf = Buffer.alloc(0);
                    let sessionKey = null;
                    const COOKIES_ID = 1, EVAL_ID = 2;

                    function wsSend(data) {
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
                        const masked = Buffer.alloc(msg.length);
                        for (let i = 0; i < msg.length; i++) masked[i] = msg[i] ^ mask[i % 4];
                        sock.write(Buffer.concat([hdr, masked]));
                    }

                    sock.on('connect', () => {
                        sock.write(
                            `GET ${wsUrl.pathname} HTTP/1.1\r\nHost: ${wsUrl.host}\r\n` +
                            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
                            `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`
                        );
                    });

                    sock.on('data', (chunk) => {
                        if (!upgraded) {
                            const str = chunk.toString();
                            if (str.includes('101')) {
                                upgraded = true;
                                const idx = str.indexOf('\r\n\r\n');
                                buf = idx !== -1 ? chunk.slice(idx + 4) : Buffer.alloc(0);
                                wsSend({ id: COOKIES_ID, method: 'Network.getAllCookies' });
                            }
                            return;
                        }
                        buf = Buffer.concat([buf, chunk]);
                        while (buf.length >= 2) {
                            let len = buf[1] & 0x7f;
                            let offset = 2;
                            if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
                            else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
                            if (buf.length < offset + len) break;
                            const payload = buf.slice(offset, offset + len).toString();
                            buf = buf.slice(offset + len);
                            try {
                                const m = JSON.parse(payload);
                                if (m.id === COOKIES_ID && m.result && m.result.cookies) {
                                    const sk = m.result.cookies.find(c => c.name === 'sessionKey' && c.domain.includes('claude'));
                                    sessionKey = sk ? sk.value : null;
                                    if (claudeTab) {
                                        const expr = `(async()=>{try{
                                            const orgs=await fetch('/api/organizations',{credentials:'include'}).then(r=>r.json());
                                            if(!Array.isArray(orgs)||!orgs[0])return JSON.stringify({error:'no orgs'});
                                            let best=null,bestUtil=-1;
                                            for(const org of orgs){
                                                const id=org.uuid||org.id;
                                                const u=await fetch('/api/organizations/'+id+'/usage',{credentials:'include'}).then(r=>r.json());
                                                const util=(u.five_hour&&u.five_hour.utilization)||0;
                                                if(util>bestUtil||(util===bestUtil&&!best)){bestUtil=util;best=u;}
                                            }
                                            return JSON.stringify(best||{});
                                        }catch(e){return JSON.stringify({error:e.message});}})()`;
                                        wsSend({ id: EVAL_ID, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 } });
                                    } else {
                                        sock.destroy();
                                        resolve({ sessionKey, error: sessionKey ? null : 'no sessionKey' });
                                    }
                                }
                                if (m.id === EVAL_ID) {
                                    let usage = null;
                                    try {
                                        const val = m.result && m.result.result && m.result.result.value;
                                        if (val) {
                                            const parsed = typeof val === 'string' ? JSON.parse(val) : val;
                                            if (parsed && !parsed.error) usage = parsed;
                                        }
                                    } catch {}
                                    sock.destroy();
                                    resolve({ sessionKey, usage });
                                }
                            } catch {}
                        }
                    });
                } catch { resolve({ error: 'parse error' }); }
            });
        }).on('error', () => resolve({ error: `Chrome nu ruleaza cu debug port ${port}` }));
    });
}

// ── Usage refresh ────────────────────────────────────────────────────────────

function fetchAndUpdateUsage() {
    const active = getActive();
    if (!active) return;
    const widgetFile = path.join(ACCOUNTS_DIR, `${active}.widget.json`);
    try {
        const data = JSON.parse(fs.readFileSync(widgetFile, 'utf8'));
        if (data.usage) updateStatusBar({ usage: data.usage });
    } catch {}
}

function startUsageRefresh() {
    fetchAndUpdateUsage();
    if (usageRefreshTimer) clearInterval(usageRefreshTimer);
    usageRefreshTimer = setInterval(fetchAndUpdateUsage, 60 * 1000);
}

function getSessionKey(accountName) {
    const accountWidget = path.join(ACCOUNTS_DIR, `${accountName}.widget.json`);
    if (fs.existsSync(accountWidget)) {
        try { return JSON.parse(fs.readFileSync(accountWidget, 'utf8')).sessionKey; } catch {}
    }
    if (fs.existsSync(WIDGET_STORE)) {
        try { return JSON.parse(fs.readFileSync(WIDGET_STORE, 'utf8')).sessionKey; } catch {}
    }
    return null;
}

// ── Widget / session helpers ─────────────────────────────────────────────────

const PYTHON_EXE     = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe');
const GET_SESSION_PY = path.join(os.homedir(), 'claude-account-switcher', 'get-session-key.py');

function restoreWidgetSession(name) {
    const profileFile = path.join(ACCOUNTS_DIR, `${name}.profile`);
    if (fs.existsSync(profileFile) && fs.existsSync(PYTHON_EXE) && fs.existsSync(GET_SESSION_PY)) {
        const profileDir = fs.readFileSync(profileFile, 'utf8').trim();
        exec(`"${PYTHON_EXE}" "${GET_SESSION_PY}" "${profileDir}" "${name}"`, (err, stdout, stderr) => {
            if (err) console.error('Widget session error:', stderr);
        });
        return true;
    }
    const saved = path.join(ACCOUNTS_DIR, `${name}.widget.json`);
    if (!fs.existsSync(saved)) return false;
    try {
        const dir = path.dirname(WIDGET_STORE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(saved, WIDGET_STORE);
        return true;
    } catch { return false; }
}

function launchWidget() {
    if (!fs.existsSync(ELECTRON_EXE)) return;
    exec(`taskkill /IM electron.exe /F`, () => {
        setTimeout(() => exec(`"${ELECTRON_EXE}" "${WIDGET_DIR}"`), 800);
    });
}

// ── Add account ──────────────────────────────────────────────────────────────

async function addAccount() {
    const name = await vscode.window.showInputBox({
        title: 'Adauga cont Claude',
        prompt: 'Numele contului (ex: paunescu@powerhost.ro)',
        ignoreFocusOut: true
    });
    if (!name) { showMenu(); return; }

    let profiles = getChromeProfiles();
    let profileDir = null;

    if (profiles.length > 0) {
        while (true) {
            const items = [
                { label: '$(arrow-left) Inapoi la meniu', dir: '__back__' },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                ...profiles.map(p => ({ label: p.name, description: p.email, dir: p.dir })),
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                { label: '$(person-add) Adauga profil Chrome nou', dir: '__new__' },
                { label: '$(refresh) Refresh profiluri Chrome', dir: '__refresh__' }
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Alege profilul Chrome pentru acest cont',
                ignoreFocusOut: true
            });
            if (!picked || picked.dir === '__back__') { showMenu(); return; }
            if (picked.dir === '__refresh__') { profiles = getChromeProfiles(); continue; }
            if (picked.dir === '__new__') {
                const newName = await vscode.window.showInputBox({
                    title: 'Profil Chrome nou — Nume',
                    prompt: 'Numele profilului (ex: claude cos)',
                    ignoreFocusOut: true
                });
                if (!newName) continue;
                const newEmail = await vscode.window.showInputBox({
                    title: 'Profil Chrome nou — Email',
                    prompt: 'Email-ul contului (ex: cos@powerhost.ro)',
                    ignoreFocusOut: true
                });
                const newDir = createChromeProfile(newName, newEmail || '');
                vscode.window.showInformationMessage(`Profil "${newName}"${newEmail ? ` (${newEmail})` : ''} creat (${newDir})`);
                profiles = getChromeProfiles();
                continue;
            }
            profileDir = picked.dir;
            break;
        }
    }

    // Allocate debug port for this account
    const port = allocatePort(name);

    if (profileDir && CHROME_EXE) {
        openChrome(name, profileDir);
    } else if (CHROME_EXE) {
        exec(`"${CHROME_EXE}" https://claude.ai`);
    }

    const confirm = await vscode.window.showInformationMessage(
        `Logheaza-te pe claude.ai cu contul "${name}", apoi apasa Done.`,
        { modal: true },
        'Done'
    );
    if (confirm !== 'Done') return;

    try {
        if (!fs.existsSync(CREDS_FILE)) {
            vscode.window.showWarningMessage('Nu s-a gasit fisier CLI. Ruleaza "claude" in terminal si logheaza-te mai intai.');
            return;
        }
        fs.copyFileSync(CREDS_FILE, path.join(ACCOUNTS_DIR, `${name}.json`));
        if (profileDir) fs.writeFileSync(path.join(ACCOUNTS_DIR, `${name}.profile`), profileDir, 'utf8');
        fs.writeFileSync(ACTIVE_FILE, name, 'utf8');
        updateVSCodeTitle(name);
        updateStatusBar();
        vscode.window.showInformationMessage(`Cont "${name}" salvat! (debug port: ${port})`);
    } catch (e) {
        vscode.window.showErrorMessage(`Eroare: ${e.message}`);
    }
}

// ── Main menu ────────────────────────────────────────────────────────────────

async function showMenu() {
    const accounts = getAccounts();
    const active = getActive();

    const items = [
        ...accounts.map(name => {
            const port = getAccountPort(name);
            return {
                label: `$(account) ${name}`,
                description: (name === active ? '✓ activ' : '') + (port ? ` [port ${port}]` : ''),
                action: 'switch',
                name
            };
        }),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(add) Adauga cont nou', action: 'add' },
        { label: '$(trash) Sterge cont', action: 'delete' },
        { label: '$(sync~spin) Refresh Usage', action: 'refresh-usage' },
        { label: '$(graph) Setup Usage Stats', action: 'usage-setup' }
    ];

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Switch cont sau adauga cont nou',
        title: 'Claude Account Switcher'
    });

    if (!picked) return;

    if (picked.action === 'add') { await addAccount(); return; }

    if (picked.action === 'delete') {
        const accounts = getAccounts();
        if (accounts.length === 0) {
            vscode.window.showInformationMessage('Nu exista conturi salvate.');
            return;
        }
        const toDelete = await vscode.window.showQuickPick(
            [
                { label: '$(arrow-left) Inapoi la meniu', name: '__back__' },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                ...accounts.map(name => ({ label: `$(account) ${name}`, name }))
            ],
            { title: 'Sterge cont', placeHolder: 'Alege contul de sters', ignoreFocusOut: true }
        );
        if (!toDelete || toDelete.name === '__back__') { showMenu(); return; }
        const confirm = await vscode.window.showWarningMessage(
            `Stergi contul "${toDelete.name}"? Aceasta actiune nu poate fi anulata.`,
            { modal: true }, 'Sterge'
        );
        if (confirm !== 'Sterge') return;
        for (const ext of ['.json', '.profile', '.widget.json', '.port']) {
            const f = path.join(ACCOUNTS_DIR, `${toDelete.name}${ext}`);
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
        }
        const active = getActive();
        if (active === toDelete.name) {
            try { fs.unlinkSync(ACTIVE_FILE); } catch {}
        }
        updateStatusBar();
        vscode.window.showInformationMessage(`Cont "${toDelete.name}" sters.`);
        return;
    }

    if (picked.action === 'refresh-usage') {
        const activeAcc = getActive();
        if (!activeAcc) { vscode.window.showWarningMessage('Nu exista cont activ.'); return; }
        const profileFile = path.join(ACCOUNTS_DIR, `${activeAcc}.profile`);
        const profileDir = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8').trim() : 'Default';
        const port = allocatePort(activeAcc);

        statusBarItem.text = `$(sync~spin) ${activeAcc} ...`;
        try {
            const ready = await ensureChromeDebug(activeAcc, profileDir, port);
            if (!ready) { updateStatusBar(); vscode.window.showWarningMessage(`Nu s-a putut porni Chrome cu debug port ${port}.`); return; }
            const result = await cdpRefreshUsage(port);
            if (result.sessionKey) {
                const widgetFile = path.join(ACCOUNTS_DIR, `${activeAcc}.widget.json`);
                let existing = {};
                try { existing = JSON.parse(fs.readFileSync(widgetFile, 'utf8')); } catch {}
                existing.sessionKey = result.sessionKey;
                if (result.usage) existing.usage = result.usage;
                fs.writeFileSync(widgetFile, JSON.stringify(existing, null, 2), 'utf8');
            }
            if (result.usage) {
                updateStatusBar({ usage: result.usage });
                vscode.window.showInformationMessage(`Usage actualizat pentru "${activeAcc}"`);
            } else if (result.error) {
                updateStatusBar();
                vscode.window.showWarningMessage(`Refresh usage: ${result.error}`);
            } else {
                updateStatusBar();
                vscode.window.showWarningMessage('Nu s-a putut obtine usage.');
            }
        } catch (e) {
            updateStatusBar();
            vscode.window.showWarningMessage(`Eroare: ${e.message}`);
        }
        return;
    }

    if (picked.action === 'usage-setup') {
        const activeAcc = getActive();
        if (!activeAcc) { vscode.window.showWarningMessage('Nu exista cont activ.'); return; }
        const profileFile = path.join(ACCOUNTS_DIR, `${activeAcc}.profile`);
        const profileDir = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8').trim() : 'Default';
        const port = allocatePort(activeAcc);

        statusBarItem.text = `$(sync~spin) ${activeAcc} ...`;
        const ready = await ensureChromeDebug(activeAcc, profileDir, port);
        if (!ready) { updateStatusBar(); vscode.window.showWarningMessage(`Nu s-a putut porni Chrome cu debug port ${port}.`); return; }

        await new Promise(r => setTimeout(r, 3000));

        try {
            const result = await cdpRefreshUsage(port);
            if (result.sessionKey) {
                const widgetFile = path.join(ACCOUNTS_DIR, `${activeAcc}.widget.json`);
                let existing = {};
                try { existing = JSON.parse(fs.readFileSync(widgetFile, 'utf8')); } catch {}
                existing.sessionKey = result.sessionKey;
                if (result.usage) existing.usage = result.usage;
                fs.writeFileSync(widgetFile, JSON.stringify(existing, null, 2), 'utf8');
                if (result.usage) updateStatusBar({ usage: result.usage });
                vscode.window.showInformationMessage(`SessionKey capturat pentru "${activeAcc}"! (port ${port})`);
            } else {
                updateStatusBar();
                vscode.window.showWarningMessage(`Nu s-a capturat sessionKey: ${result.error || 'necunoscut'}`);
            }
        } catch (e) {
            updateStatusBar();
            vscode.window.showWarningMessage(`Eroare: ${e.message}`);
        }
        return;
    }

    // ── Switch account ───────────────────────────────────────────────────────
    if (!picked.name || picked.name === active) return;

    const REFRESH_PY = path.join(os.homedir(), 'claude-account-switcher', 'refresh-token.py');
    const src = path.join(ACCOUNTS_DIR, `${picked.name}.json`);
    try {
        if (fs.existsSync(PYTHON_EXE) && fs.existsSync(REFRESH_PY)) {
            const { execSync } = require('child_process');
            try { execSync(`"${PYTHON_EXE}" "${REFRESH_PY}" "${src}"`, { timeout: 15000 }); } catch {}
        }
        fs.copyFileSync(src, CREDS_FILE);
        fs.writeFileSync(ACTIVE_FILE, picked.name, 'utf8');
        updateVSCodeTitle(picked.name);
        updateStatusBar();
        restoreWidgetSession(picked.name);
        launchWidget();

        const profileFile = path.join(ACCOUNTS_DIR, `${picked.name}.profile`);
        if (fs.existsSync(profileFile)) {
            openChrome(picked.name, fs.readFileSync(profileFile, 'utf8').trim());
        }

        vscode.window.showInformationMessage(`Switched la: ${picked.name}`);
        lastUsage = null;
        updateStatusBar();
        setTimeout(fetchAndUpdateUsage, 5000);
    } catch (e) {
        vscode.window.showErrorMessage(`Eroare la switch: ${e.message}`);
    }
}

// ── Activation ───────────────────────────────────────────────────────────────

function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    statusBarItem.command = 'claudeSwitch.switch';
    updateStatusBar();
    statusBarItem.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeSwitch.switch', showMenu),
        statusBarItem
    );

    try {
        const watcher = fs.watch(ACCOUNTS_DIR, () => updateStatusBar());
        context.subscriptions.push({ dispose: () => watcher.close() });
    } catch {}

    startUsageRefresh();
    context.subscriptions.push({ dispose: () => { if (usageRefreshTimer) clearInterval(usageRefreshTimer); } });
}

function deactivate() {
    if (usageRefreshTimer) clearInterval(usageRefreshTimer);
}

module.exports = { activate, deactivate };

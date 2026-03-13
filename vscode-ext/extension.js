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

function createChromeProfile(profileName, email = '') {
    // Gaseste urmatorul director disponibil (Profile 1, Profile 2, ...)
    let dirName = 'Profile 1';
    let n = 1;
    while (fs.existsSync(path.join(CHROME_USER_DATA, dirName))) {
        n++;
        dirName = `Profile ${n}`;
    }

    // Creeaza directorul
    const profilePath = path.join(CHROME_USER_DATA, dirName);
    fs.mkdirSync(profilePath, { recursive: true });

    // Creeaza Preferences cu numele profilului
    const prefs = {
        profile: {
            name: profileName,
            is_using_default_name: false,
            user_name: email
        }
    };
    fs.writeFileSync(
        path.join(profilePath, 'Preferences'),
        JSON.stringify(prefs, null, 2),
        'utf8'
    );

    // Actualizeaza Local State sa recunoasca profilul
    try {
        const ls = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
        if (!ls.profile) ls.profile = {};
        if (!ls.profile.info_cache) ls.profile.info_cache = {};
        ls.profile.info_cache[dirName] = {
            name: profileName,
            is_using_default_name: false,
            user_name: email,
            active_time: Date.now() / 1000
        };
        fs.writeFileSync(LOCAL_STATE, JSON.stringify(ls), 'utf8');
    } catch {}

    return dirName;
}

let statusBarItem;

function getActive() {
    try { return fs.readFileSync(ACTIVE_FILE, 'utf8').trim(); } catch { return null; }
}

function getAccounts() {
    try {
        return fs.readdirSync(ACCOUNTS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    } catch { return []; }
}

function getChromeProfiles() {
    try {
        const data = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
        const cache = data.profile.info_cache;
        return Object.entries(cache).map(([dir, info]) => ({
            dir,
            name: info.name || dir,
            email: info.user_name || ''
        }));
    } catch { return []; }
}

let lastUsage = null;
let usageRefreshTimer = null;

function formatUsage(u) {
    if (!u) return null;
    const pct = u.utilization !== undefined ? Math.round(u.utilization * 100) : null;
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
    return lines.join('\n');
}

function updateStatusBar(usageData) {
    if (usageData !== undefined) lastUsage = usageData;
    const active = getActive();
    const u = lastUsage && lastUsage.usage;
    const fivePct = u && u.five_hour && u.five_hour.utilization !== undefined
        ? Math.round(u.five_hour.utilization * 100) : null;
    statusBarItem.text = fivePct !== null
        ? `$(account) ${active || 'Claude'} ${fivePct}%`
        : `$(account) ${active || 'Claude'}`;
    statusBarItem.tooltip = buildTooltip(active, lastUsage);
}

function fetchAndUpdateUsage() {
    const active = getActive();
    if (!active || !fs.existsSync(PYTHON_EXE) || !fs.existsSync(GET_USAGE_PY)) return;
    const profileFile = path.join(ACCOUNTS_DIR, `${active}.profile`);
    if (!fs.existsSync(profileFile)) return;
    const profileDir = fs.readFileSync(profileFile, 'utf8').trim();
    exec(`"${PYTHON_EXE}" "${GET_USAGE_PY}" "${profileDir}"`, { timeout: 20000 }, (err, stdout) => {
        if (err || !stdout) return;
        try {
            const data = JSON.parse(stdout.trim());
            if (!data.error) updateStatusBar(data);
        } catch {}
    });
}

function startUsageRefresh() {
    fetchAndUpdateUsage();
    if (usageRefreshTimer) clearInterval(usageRefreshTimer);
    usageRefreshTimer = setInterval(fetchAndUpdateUsage, 5 * 60 * 1000);
}

function updateVSCodeTitle(name) {
    try {
        const s = JSON.parse(fs.readFileSync(VS_SETTINGS, 'utf8'));
        s['window.title'] = `${name} | \${activeEditorShort}\${separator}\${rootName}`;
        fs.writeFileSync(VS_SETTINGS, JSON.stringify(s, null, 4), 'utf8');
    } catch {}
}

function openChrome(profileDir) {
    if (!CHROME_EXE) return;
    const userDataDir = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    exec(`"${CHROME_EXE}" --user-data-dir="${userDataDir}" --profile-directory="${profileDir}" --new-window https://claude.ai`);
}

const PYTHON_EXE     = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe');
const GET_SESSION_PY = path.join(os.homedir(), 'claude-account-switcher', 'get-session-key.py');
const GET_USAGE_PY   = path.join(os.homedir(), 'claude-account-switcher', 'get-usage.py');

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
                ...profiles.map(p => ({
                    label: p.name,
                    description: p.email,
                    dir: p.dir
                })),
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                { label: '$(person-add) Adauga profil Chrome nou', dir: '__new__' },
                { label: '$(refresh) Refresh profiluri Chrome', dir: '__refresh__' }
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Alege profilul Chrome pentru acest cont',
                ignoreFocusOut: true
            });
            if (!picked || picked.dir === '__back__') { showMenu(); return; }
            if (picked.dir === '__refresh__') {
                profiles = getChromeProfiles();
                continue;
            }
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

    if (profileDir && CHROME_EXE) {
        openChrome(profileDir);
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
        vscode.window.showInformationMessage(`Cont "${name}" salvat!`);
    } catch (e) {
        vscode.window.showErrorMessage(`Eroare: ${e.message}`);
    }
}

async function showMenu() {
    const accounts = getAccounts();
    const active = getActive();

    const items = [
        ...accounts.map(name => ({
            label: `$(account) ${name}`,
            description: name === active ? '✓ activ' : '',
            action: 'switch',
            name
        })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(add) Adauga cont nou', action: 'add' },
        { label: '$(trash) Sterge cont', action: 'delete' }
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
        for (const ext of ['.json', '.profile', '.widget.json']) {
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

    if (picked.name === active) return;

    const REFRESH_PY = path.join(os.homedir(), 'claude-account-switcher', 'refresh-token.py');
    const src = path.join(ACCOUNTS_DIR, `${picked.name}.json`);
    try {
        // Refresh token inainte de switch
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
            openChrome(fs.readFileSync(profileFile, 'utf8').trim());
        }

        vscode.window.showInformationMessage(`Switched la: ${picked.name}`);
        lastUsage = null;
        updateStatusBar();
        setTimeout(fetchAndUpdateUsage, 1000);
    } catch (e) {
        vscode.window.showErrorMessage(`Eroare la switch: ${e.message}`);
    }
}

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

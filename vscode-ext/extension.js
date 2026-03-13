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
const CHROME_EXE    = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));

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

function updateStatusBar() {
    const active = getActive();
    statusBarItem.text = `$(account) ${active || 'Claude'}`;
    statusBarItem.tooltip = 'Click pentru switch / adauga cont Claude';
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
    if (!name) return;

    const profiles = getChromeProfiles();
    let profileDir = null;

    if (profiles.length > 0) {
        while (true) {
            const items = [
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
            if (!picked) break;
            if (picked.dir === '__refresh__') {
                profiles = getChromeProfiles();
                continue;
            }
            if (picked.dir === '__new__') {
                if (CHROME_EXE) exec(`"${CHROME_EXE}" chrome://profile-picker`);
                await vscode.window.showInformationMessage(
                    'Creeaza profilul in Chrome, apoi apasa OK pentru refresh.',
                    { modal: true }, 'OK'
                );
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
        { label: '$(key) Auto-Login (Chrome + Playwright)', action: 'autologin' }
    ];

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Switch cont sau adauga cont nou',
        title: 'Claude Account Switcher'
    });

    if (!picked) return;

    if (picked.action === 'add') { await addAccount(); return; }

    if (picked.action === 'autologin') {
        const name = await vscode.window.showInputBox({
            title: 'Auto-Login',
            prompt: 'Numele contului (ex: paunescu@powerhost.ro)',
            ignoreFocusOut: true
        });
        if (!name) return;

        const profiles = getChromeProfiles();
        let profileDir = null;
        if (profiles.length > 0) {
            const p = await vscode.window.showQuickPick(
                profiles.map(p => ({ label: p.name, description: p.email, dir: p.dir })),
                { title: 'Alege profilul Chrome', ignoreFocusOut: true }
            );
            if (p) profileDir = p.dir;
        }

        const AUTO_LOGIN_JS = path.join(os.homedir(), 'claude-account-switcher', 'auto-login.js');
        if (!fs.existsSync(AUTO_LOGIN_JS)) {
            vscode.window.showErrorMessage('auto-login.js nu a fost gasit.');
            return;
        }

        vscode.window.showInformationMessage(`Auto-login pornit pentru "${name}". Urmareste terminalul...`);
        const terminal = vscode.window.createTerminal('Claude Auto-Login');
        terminal.show();
        terminal.sendText(`node "${AUTO_LOGIN_JS}" "${profileDir || 'Default'}" "${name}"`);
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
}

function deactivate() {}

module.exports = { activate, deactivate };

/**
 * auto-login.js — Detecteaza login claude.ai + iCloud, deschide ce lipseste
 * Usage: node auto-login.js "<profile_dir>" "<account_name>" "<icloud_email>"
 * Ex:    node auto-login.js "Profile 1" "claude cristi" "cristi@powerhost.ro"
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const PROFILE_DIR  = process.argv[2] || 'Default';
const ACCOUNT_NAME = process.argv[3] || '';
const ICLOUD_EMAIL = process.argv[4] || '';

const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const CHROME_EXE = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));

const PYTHON_EXE    = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe');
const CHECK_PY      = path.join(__dirname, 'check-cookies.py');
const ACCOUNTS_DIR  = path.join(os.homedir(), '.claude', 'accounts');

function openChromeTab(url) {
    if (!CHROME_EXE) { console.log('  Chrome nu a fost gasit.'); return; }
    exec(`"${CHROME_EXE}" "--profile-directory=${PROFILE_DIR}" "${url}"`);
    console.log(`  Deschis: ${url}`);
}

function checkCookies() {
    if (!fs.existsSync(PYTHON_EXE) || !fs.existsSync(CHECK_PY)) {
        return { claudeLoggedIn: false, icloudLoggedIn: false, claudeEmail: null };
    }
    try {
        const out = execSync(
            `"${PYTHON_EXE}" "${CHECK_PY}" "${PROFILE_DIR}" "${ICLOUD_EMAIL}"`,
            { encoding: 'utf8', timeout: 10000 }
        );
        const lines = out.trim().split('\n');
        return JSON.parse(lines[lines.length - 1]);
    } catch (e) {
        return { claudeLoggedIn: false, icloudLoggedIn: false, claudeEmail: null };
    }
}

function main() {
    console.log(`\n=== Check Login: ${ACCOUNT_NAME || PROFILE_DIR} ===\n`);

    const status = checkCookies();

    const claudeStatus  = status.claudeLoggedIn  ? '✓ LOGAT'  : '✗ nelogat';
    const icloudStatus  = status.icloudLoggedIn  ? '✓ LOGAT'  : '✗ nelogat';

    console.log(`  claude.ai : ${claudeStatus}${status.claudeEmail ? ` (${status.claudeEmail})` : ''}`);
    if (ICLOUD_EMAIL) {
        console.log(`  iCloud    : ${icloudStatus} (${ICLOUD_EMAIL})`);
    }
    console.log('');

    let opened = false;

    if (!status.claudeLoggedIn) {
        console.log('  Deschid claude.ai...');
        openChromeTab('https://claude.ai');
        opened = true;
    }

    if (ICLOUD_EMAIL && !status.icloudLoggedIn) {
        console.log('  Deschid iCloud Mail...');
        openChromeTab('https://www.icloud.com/mail');
        opened = true;
    }

    if (!opened) {
        console.log('  Totul e OK! Esti logat pe toate site-urile necesare.');

        // Salveaza sessionKey daca nu e deja salvat
        const GET_SESSION_PY = path.join(__dirname, 'get-session-key.py');
        if (ACCOUNT_NAME && fs.existsSync(GET_SESSION_PY)) {
            try {
                execSync(`"${PYTHON_EXE}" "${GET_SESSION_PY}" "${PROFILE_DIR}" "${ACCOUNT_NAME}"`, { encoding: 'utf8' });
                console.log('  SessionKey salvat pentru widget.');
            } catch {}
        }
    } else {
        console.log('\n  Logheaza-te, apoi re-ruleaza comanda pentru a verifica.');
    }
}

main();

/**
 * Automatizeaza "claude login" folosind Chrome-ul deja logat.
 * Usage: node auto-login.js <profile_dir> <account_name>
 *
 * Fluxul:
 * 1. Porneste `claude login` care deschide un browser cu URL OAuth
 * 2. Playwright deschide Chrome cu profilul corect la acelasi URL
 * 3. User-ul e deja logat => click automat pe Authorize
 * 4. Token-ul e capturat si salvat in credentials
 */

const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const profileDir  = process.argv[2] || 'Default';
const accountName = process.argv[3] || 'cont';

const ACCOUNTS_DIR = path.join(os.homedir(), '.claude', 'accounts');
const CREDS_FILE   = path.join(os.homedir(), '.claude', '.credentials.json');
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

async function run() {
    console.log(`Pornesc auto-login pentru: ${accountName} (${profileDir})`);

    // Porneste `claude login` si captureaza URL-ul OAuth din output
    const claudeLogin = spawn('claude', ['login'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
    });

    let oauthUrl = null;

    await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(), 15000);
        claudeLogin.stdout.on('data', (data) => {
            const text = data.toString();
            console.log('[claude]', text.trim());
            const match = text.match(/https:\/\/claude\.ai\/[^\s]+/);
            if (match) {
                oauthUrl = match[0];
                clearTimeout(timeout);
                resolve();
            }
        });
        claudeLogin.stderr.on('data', (data) => {
            const text = data.toString();
            const match = text.match(/https:\/\/claude\.ai\/[^\s]+/);
            if (match) {
                oauthUrl = match[0];
                clearTimeout(timeout);
                resolve();
            }
        });
    });

    if (!oauthUrl) {
        console.error('Nu s-a putut captura URL-ul OAuth din "claude login"');
        claudeLogin.kill();
        process.exit(1);
    }

    console.log('URL OAuth capturat:', oauthUrl);

    // Deschide Chrome cu profilul corect la URL-ul OAuth
    const browser = await chromium.launchPersistentContext(
        path.join(CHROME_USER_DATA, profileDir),
        {
            headless: false,
            executablePath: [
                path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            ].find(p => fs.existsSync(p)),
            args: ['--no-first-run', '--no-default-browser-check']
        }
    );

    const page = await browser.newPage();
    await page.goto(oauthUrl, { waitUntil: 'domcontentloaded' });

    // Asteapta butonul de Authorize si da click
    try {
        await page.waitForSelector('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Continue")', { timeout: 10000 });
        await page.click('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Continue")');
        console.log('Click pe Authorize efectuat!');
    } catch {
        console.log('Nu s-a gasit buton de autorizare - poate deja autorizat sau necesita actiune manuala');
    }

    // Asteapta claude login sa termine (token salvat)
    await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 15000);
        claudeLogin.on('close', () => { clearTimeout(timeout); resolve(); });
    });

    await browser.close();

    // Salveaza credentials pentru cont
    if (fs.existsSync(CREDS_FILE)) {
        fs.copyFileSync(CREDS_FILE, path.join(ACCOUNTS_DIR, `${accountName}.json`));
        fs.writeFileSync(path.join(ACCOUNTS_DIR, '.active'), accountName, 'utf8');
        console.log(`Cont "${accountName}" autentificat si salvat!`);
    } else {
        console.error('Credentialele nu au fost salvate de claude login');
        process.exit(1);
    }

    claudeLogin.kill();
}

run().catch(e => { console.error(e); process.exit(1); });

/**
 * Automatizeaza "claude login" folosind Chrome-ul deja logat.
 * Daca userul nu e logat pe claude.ai, il logheaza via magic link din iCloud Mail.
 * Usage: node auto-login.js <profile_dir> <account_name> [email]
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const profileDir  = process.argv[2] || 'Default';
const accountName = process.argv[3] || 'cont';
const emailArg    = process.argv[4] || null;

const ACCOUNTS_DIR     = path.join(os.homedir(), '.claude', 'accounts');
const CREDS_FILE       = path.join(os.homedir(), '.claude', '.credentials.json');
const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const ACCOUNT_META     = path.join(ACCOUNTS_DIR, `${accountName}.meta.json`);

const CHROME_EXE = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));

const CLAUDE_EXE = (() => {
    // Cauta in extensia VSCode
    const extDir = path.join(os.homedir(), '.vscode', 'extensions');
    if (fs.existsSync(extDir)) {
        const dirs = fs.readdirSync(extDir).filter(d => d.startsWith('anthropic.claude-code'));
        for (const d of dirs.sort().reverse()) {
            const exe = path.join(extDir, d, 'resources', 'native-binary', 'claude.exe');
            if (fs.existsSync(exe)) return exe;
        }
    }
    return 'claude'; // fallback
})();

function loadMeta() {
    try { return JSON.parse(fs.readFileSync(ACCOUNT_META, 'utf8')); } catch { return {}; }
}
function saveMeta(data) {
    fs.writeFileSync(ACCOUNT_META, JSON.stringify(data, null, 2), 'utf8');
}

async function isLoggedInClaude(page) {
    try {
        await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        const url = page.url();
        // Daca e redirectat la /login nu e logat
        if (url.includes('/login') || url.includes('/onboarding')) return false;
        // Verifica daca exista elemente de UI logat
        const loggedIn = await page.$('[data-testid="user-menu"], nav, .conversation-list, main') !== null;
        return loggedIn;
    } catch { return false; }
}

async function loginViaMagicLink(page, email) {
    console.log(`Loghez cu email: ${email}`);

    await page.goto('https://claude.ai/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Introdu email-ul
    const emailInput = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 10000 });
    await emailInput.fill(email);

    // Click Continue / Submit
    await page.click('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")');
    console.log('Email trimis, astept magic link in iCloud...');
}

async function getMagicLinkFromICloud(browser, senderEmail) {
    console.log('Deschid iCloud Mail...');
    const mailPage = await browser.newPage();

    await mailPage.goto('https://mail.icloud.com', { waitUntil: 'load', timeout: 30000 });
    await mailPage.waitForTimeout(5000);

    // Log URL curent pentru debug
    console.log('iCloud URL:', mailPage.url());

    // Verifica daca e logat (iCloud redirecteaza la appleid daca nu e)
    if (mailPage.url().includes('appleid.apple.com') || mailPage.url().includes('signin')) {
        console.log('Nu esti logat in iCloud in acest profil Chrome');
        await mailPage.close();
        return null;
    }

    // Asteapta inbox cu multiple selectori posibili
    const inboxSelectors = [
        '.mail-message-list-scroll-view',
        '[data-test-id="mail-message-list"]',
        '.message-list',
        'ul[role="listbox"]',
        '.email-list'
    ];
    let loaded = false;
    for (const sel of inboxSelectors) {
        try {
            await mailPage.waitForSelector(sel, { timeout: 10000 });
            loaded = true;
            console.log('Inbox incarcat cu selector:', sel);
            break;
        } catch {}
    }
    if (!loaded) {
        // Fa screenshot pentru debug
        await mailPage.screenshot({ path: 'icloud-debug.png' });
        console.log('Screenshot salvat: icloud-debug.png - verifica manual');
        // Asteapta mai mult si incearca oricum
        await mailPage.waitForTimeout(5000);
    }

    // Cauta email Claude in inbox (asteapta pana 90s)
    for (let i = 0; i < 18; i++) {
        console.log(`Caut email Claude in iCloud... (${i + 1}/18, ${(i+1)*5}s)`);

        // Obtine toate elementele care ar putea fi emailuri
        const emailRows = await mailPage.$$('tr, li[role="option"], [role="listitem"], .email-row, .message-row');
        for (const row of emailRows) {
            const text = (await row.innerText().catch(() => '')).toLowerCase();
            if (text.includes('claude') || text.includes('anthropic') || text.includes('sign in') || text.includes('verify')) {
                console.log('Email potrivit gasit! Click...');
                await row.click();
                await mailPage.waitForTimeout(3000);

                // Cauta link-ul in corpul emailului
                const links = await mailPage.$$('a[href]');
                for (const link of links) {
                    const href = await link.getAttribute('href').catch(() => '');
                    if (href && (href.includes('claude.ai') || href.includes('anthropic.com')) &&
                        (href.includes('token') || href.includes('verify') || href.includes('login') || href.includes('magic') || href.includes('callback'))) {
                        console.log('Magic link gasit:', href.substring(0, 70) + '...');
                        await mailPage.close();
                        return href;
                    }
                }
            }
        }

        await mailPage.waitForTimeout(5000);
        // Apasa refresh dupa 30s
        if (i > 0 && i % 6 === 0) {
            await mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await mailPage.waitForTimeout(3000);
        }
    }

    await mailPage.close();
    console.log('Nu s-a gasit email de la Claude in 90s');
    return null;
}

async function run() {
    console.log(`\n=== Auto-Login: ${accountName} (${profileDir}) ===\n`);

    // Incarca sau cere email-ul
    const meta = loadMeta();
    let email = emailArg || meta.email;
    if (!email) {
        // Citeste din profil Chrome
        try {
            const localState = JSON.parse(fs.readFileSync(path.join(CHROME_USER_DATA, 'Local State'), 'utf8'));
            const profileInfo = localState.profile?.info_cache?.[profileDir];
            email = profileInfo?.user_name || null;
        } catch {}
    }

    // Porneste claude login si captureaza URL-ul OAuth
    console.log('Pornesc claude login...');
    // Sterge credentials expirate ca sa fortam login flow
    if (fs.existsSync(CREDS_FILE)) {
        fs.renameSync(CREDS_FILE, CREDS_FILE + '.bak');
        console.log('Credentials vechi salvate ca backup');
    }

    console.log('Claude exe:', CLAUDE_EXE);
    const loginArgs = ['auth', 'login'];
    if (email) loginArgs.push('--email', email);
    const claudeLogin = spawn(CLAUDE_EXE, loginArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
    });

    let oauthUrl = null;
    await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 20000);
        const check = (data) => {
            const text = data.toString();
            process.stdout.write('[claude] ' + text);
            const match = text.match(/https:\/\/claude\.ai\/[^\s\n]+/);
            if (match) { oauthUrl = match[0]; clearTimeout(timeout); resolve(); }
        };
        claudeLogin.stdout.on('data', check);
        claudeLogin.stderr.on('data', check);
    });

    if (!oauthUrl) {
        console.error('Nu s-a capturat URL-ul OAuth');
        claudeLogin.kill();
        process.exit(1);
    }
    console.log('\nURL OAuth:', oauthUrl);

    // Deschide Chrome cu profilul corect
    const browser = await chromium.launchPersistentContext(
        path.join(CHROME_USER_DATA, profileDir),
        {
            headless: false,
            executablePath: CHROME_EXE,
            args: ['--no-first-run', '--no-default-browser-check'],
            ignoreHTTPSErrors: true
        }
    );

    const page = await browser.newPage();

    // Mergi direct la URL-ul OAuth
    console.log('Navighez la URL OAuth...');
    await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    console.log('URL curent:', currentUrl);

    // Daca e redirectat la login, trebuie sa ne logam
    const needsLogin = currentUrl.includes('/login') || currentUrl.includes('/onboarding') ||
                       await page.$('input[type="email"]') !== null;

    if (needsLogin && email) {
        console.log('Necesita login, trimit magic link...');
        await loginViaMagicLink(page, email);
        const magicLink = await getMagicLinkFromICloud(browser, email);
        if (magicLink) {
            await page.goto(magicLink, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(3000);
            console.log('Logat via magic link!');
            // Mergi din nou la OAuth URL dupa login
            await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
        } else {
            console.log('Magic link neobtintinut - verificare manuala necesara');
            await browser.close();
            claudeLogin.kill();
            process.exit(1);
        }
    } else if (needsLogin) {
        console.error('Necesita login dar nu am email. Ruleaza: node auto-login.js <profile> <cont> <email>');
        await browser.close();
        claudeLogin.kill();
        process.exit(1);
    }

    // Click Authorize
    try {
        await page.waitForSelector('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Continue")', { timeout: 15000 });
        await page.click('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Continue")');
        console.log('Authorize efectuat!');
    } catch (e) {
        console.log('Buton Authorize negasit:', e.message);
    }

    // Asteapta claude login sa termine
    await new Promise((resolve) => {
        const t = setTimeout(resolve, 15000);
        claudeLogin.on('close', () => { clearTimeout(t); resolve(); });
    });

    await browser.close();

    // Salveaza credentials
    if (fs.existsSync(CREDS_FILE)) {
        fs.copyFileSync(CREDS_FILE, path.join(ACCOUNTS_DIR, `${accountName}.json`));
        fs.writeFileSync(path.join(ACCOUNTS_DIR, '.active'), accountName, 'utf8');
        if (email) { meta.email = email; saveMeta(meta); }
        console.log(`\nCont "${accountName}" salvat cu succes!`);

        // Afiseaza info token
        const creds = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, `${accountName}.json`), 'utf8'));
        const exp = new Date(creds.claudeAiOauth.expiresAt);
        console.log(`Token: ${creds.claudeAiOauth.accessToken.substring(0, 25)}...`);
        console.log(`Expira: ${exp.toLocaleString()}`);
    } else {
        // Restaureaza backup daca login a esuat
        if (fs.existsSync(CREDS_FILE + '.bak')) {
            fs.renameSync(CREDS_FILE + '.bak', CREDS_FILE);
            console.log('Backup restaurat (login esuat)');
        }
        console.error('Credentialele nu au fost salvate');
        process.exit(1);
    }

    // Sterge backup dupa succes
    if (fs.existsSync(CREDS_FILE + '.bak')) fs.unlinkSync(CREDS_FILE + '.bak');
    claudeLogin.kill();
}

run().catch(e => { console.error(e); process.exit(1); });

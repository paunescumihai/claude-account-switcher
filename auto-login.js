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

async function getMagicLinkFromICloud(browser, emailPrefix) {
    console.log('Deschid iCloud Mail...');
    const mailPage = await browser.newPage();

    await mailPage.goto('https://mail.icloud.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await mailPage.waitForTimeout(3000);

    // Asteapta sa se incarce inbox-ul
    try {
        await mailPage.waitForSelector('.mail-message-list, [data-testid="message-list"], .message-list-item', { timeout: 20000 });
    } catch {
        console.log('iCloud Mail nu s-a incarcat - poate nu esti logat in iCloud in acest profil Chrome');
        return null;
    }

    // Cauta email de la claude/anthropic (asteapta pana la 60s)
    for (let i = 0; i < 12; i++) {
        console.log(`Caut email Claude in iCloud... (${i + 1}/12)`);

        // Refresh inbox
        await mailPage.keyboard.press('F5').catch(() => {});
        await mailPage.waitForTimeout(5000);

        // Cauta in lista de mesaje
        const messages = await mailPage.$$('[data-testid="message-list-item"], .message-list-item, li[role="option"]');
        for (const msg of messages) {
            const text = await msg.innerText().catch(() => '');
            if (text.toLowerCase().includes('claude') || text.toLowerCase().includes('anthropic') || text.toLowerCase().includes('sign in')) {
                console.log('Email gasit! Deschid...');
                await msg.click();
                await mailPage.waitForTimeout(2000);

                // Cauta link-ul magic in email
                const link = await mailPage.$('a[href*="claude.ai"], a[href*="magic"], a[href*="verify"], a[href*="login"]');
                if (link) {
                    const href = await link.getAttribute('href');
                    console.log('Magic link gasit:', href.substring(0, 60) + '...');
                    await mailPage.close();
                    return href;
                }
            }
        }
    }

    await mailPage.close();
    console.log('Nu s-a gasit email de la Claude in 60s');
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
    const claudeLogin = spawn('claude', ['login'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
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

    // Verifica daca e logat pe claude.ai
    const loggedIn = await isLoggedInClaude(page);
    console.log('Logat pe claude.ai:', loggedIn);

    if (!loggedIn && email) {
        // Logheaza via magic link
        await loginViaMagicLink(page, email);

        // Ia magic link din iCloud
        const magicLink = await getMagicLinkFromICloud(browser, email);
        if (magicLink) {
            await page.goto(magicLink, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(3000);
            console.log('Magic link accesat, logat!');
            if (email) { meta.email = email; saveMeta(meta); }
        } else {
            console.log('Nu s-a putut obtine magic link automat');
            await browser.close();
            claudeLogin.kill();
            process.exit(1);
        }
    } else if (!loggedIn) {
        console.error('Nu esti logat si nu am email pentru login automat.');
        console.error('Ruleaza cu: node auto-login.js <profile> <cont> <email@icloud.com>');
        await browser.close();
        claudeLogin.kill();
        process.exit(1);
    }

    // Acum mergi la URL-ul OAuth
    await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Click Authorize
    try {
        await page.waitForSelector('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Continue")', { timeout: 10000 });
        await page.click('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Continue")');
        console.log('Authorize efectuat!');
    } catch {
        console.log('Buton Authorize negasit - poate deja autorizat');
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
        console.error('Credentialele nu au fost salvate');
        process.exit(1);
    }

    claudeLogin.kill();
}

run().catch(e => { console.error(e); process.exit(1); });

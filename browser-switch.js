// browser-switch.js — Playwright browser session manager for Claude accounts
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const mode        = process.argv[2]; // 'capture' | 'switch'
const accountName = process.argv[3];
const accountsDir = path.join(process.env.USERPROFILE, '.claude', 'accounts');
const stateFile   = path.join(accountsDir, `browser-${accountName}.json`);

if (!accountName) {
    console.error('Folosire: node browser-switch.js <capture|switch> <nume-cont>');
    process.exit(1);
}

async function capture() {
    console.log(`\n Deschid browser pentru contul: ${accountName}`);
    console.log(' Logheaza-te pe claude.ai, apoi inchide browserul.\n');

    const browser = await chromium.launch({ headless: false, channel: 'chrome' }).catch(() =>
        chromium.launch({ headless: false })
    );

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://claude.ai');

    // Asteapta pana utilizatorul inchide browser-ul
    browser.on('disconnected', async () => {
        console.log(' Browser inchis. Se salveaza sesiunea...');
    });

    await browser.waitForEvent('disconnected');

    // Salveaza state-ul dupa inchidere (context ramane disponibil scurt timp)
    try {
        await context.storageState({ path: stateFile });
        console.log(` Sesiunea salvata pentru: ${accountName}`);
        console.log(` Fisier: ${stateFile}`);
    } catch (e) {
        console.error(' Eroare la salvarea sesiunii:', e.message);
    }
}

async function switchAccount() {
    if (!fs.existsSync(stateFile)) {
        console.error(` Nu exista sesiune salvata pentru: ${accountName}`);
        console.error(` Ruleaza mai intai optiunea [B] din meniu.`);
        process.exit(1);
    }

    console.log(`\n Deschid claude.ai ca: ${accountName}`);

    const browser = await chromium.launch({ headless: false, channel: 'chrome' }).catch(() =>
        chromium.launch({ headless: false })
    );

    const context = await browser.newContext({ storageState: stateFile });
    const page = await context.newPage();
    await page.goto('https://claude.ai');

    // Verifica daca s-a logat corect
    try {
        await page.waitForURL('**/claude.ai/**', { timeout: 10000 });
        const title = await page.title();
        console.log(` Browser deschis: ${title}`);
    } catch (e) {
        console.log(' Pagina deschisa (verificare timeout)');
    }

    console.log('\n Browser deschis. Inchide fereastra cand termini.');
    console.log(' (Sesiunea nu se re-salveaza automat)\n');

    // Tine procesul viu cat timp browser-ul e deschis
    await browser.waitForEvent('disconnected');
    console.log(' Browser inchis.');
}

if (mode === 'capture') {
    capture().catch(console.error);
} else if (mode === 'switch') {
    switchAccount().catch(console.error);
} else {
    console.error('Mod invalid. Foloseste: capture sau switch');
    process.exit(1);
}

// background.js — handles cookie save/restore for claude.ai

const DOMAIN = 'claude.ai';

// Colecteaza toate cookie-urile pentru claude.ai
async function collectCookies() {
  const cookies = await chrome.cookies.getAll({ domain: DOMAIN });
  return cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain,
    path: c.path, secure: c.secure, httpOnly: c.httpOnly,
    sameSite: c.sameSite, expirationDate: c.expirationDate
  }));
}

// Sterge toate cookie-urile pentru claude.ai
async function clearCookies() {
  const cookies = await chrome.cookies.getAll({ domain: DOMAIN });
  for (const c of cookies) {
    const url = `https://${c.domain.replace(/^\./, '')}${c.path}`;
    await chrome.cookies.remove({ url, name: c.name });
  }
}

// Seteaza cookie-urile salvate
async function setCookies(cookies) {
  for (const c of cookies) {
    const url = `https://${c.domain.replace(/^\./, '')}${c.path}`;
    try {
      await chrome.cookies.set({
        url, name: c.name, value: c.value,
        domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate
      });
    } catch (e) { /* unele cookie-uri pot fi read-only */ }
  }
}

// Listener pentru mesaje din popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { action, accountName, cookies } = msg;

    if (action === 'save') {
      const data = await chrome.storage.local.get('accounts');
      const accounts = data.accounts || {};
      accounts[accountName] = { cookies: await collectCookies(), savedAt: Date.now() };
      await chrome.storage.local.set({ accounts });
      sendResponse({ ok: true });

    } else if (action === 'switch') {
      const data = await chrome.storage.local.get(['accounts', 'active']);
      const accounts = data.accounts || {};
      if (!accounts[accountName]) {
        sendResponse({ ok: false, error: 'Cont inexistent' });
        return;
      }
      await clearCookies();
      await setCookies(accounts[accountName].cookies);
      await chrome.storage.local.set({ active: accountName });

      // Reload tab-ul activ cu claude.ai sau deschide unul nou
      const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
      if (tabs.length > 0) {
        await chrome.tabs.reload(tabs[0].id);
      } else {
        await chrome.tabs.create({ url: 'https://claude.ai' });
      }
      sendResponse({ ok: true });

    } else if (action === 'delete') {
      const data = await chrome.storage.local.get('accounts');
      const accounts = data.accounts || {};
      delete accounts[accountName];
      await chrome.storage.local.set({ accounts });
      sendResponse({ ok: true });

    } else if (action === 'list') {
      const data = await chrome.storage.local.get(['accounts', 'active']);
      const accounts = data.accounts || {};
      sendResponse({ accounts: Object.keys(accounts), active: data.active || null });
    }
  })();
  return true; // async response
});

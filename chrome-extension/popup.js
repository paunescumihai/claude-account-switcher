function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type;
  if (msg) setTimeout(() => { el.textContent = ''; el.className = ''; }, 3000);
}

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function loadAccounts() {
  const { accounts, active } = await send({ action: 'list' });
  const list = document.getElementById('accounts-list');

  if (!accounts || accounts.length === 0) {
    list.innerHTML = '<div class="empty">Niciun cont salvat</div>';
    return;
  }

  list.innerHTML = '';
  for (const name of accounts) {
    const row = document.createElement('div');
    row.className = 'account-row' + (name === active ? ' active' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'account-name';
    nameEl.textContent = name;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'account-actions';

    if (name === active) {
      const badge = document.createElement('span');
      badge.className = 'account-badge';
      badge.textContent = 'ACTIV';
      actionsEl.appendChild(badge);
    } else {
      const switchBtn = document.createElement('button');
      switchBtn.className = 'btn-small';
      switchBtn.textContent = 'Switch';
      switchBtn.onclick = async (e) => {
        e.stopPropagation();
        setStatus('Se face switch...');
        const res = await send({ action: 'switch', accountName: name });
        if (res.ok) {
          setStatus('Switched la: ' + name, 'ok');
          await loadAccounts();
        } else {
          setStatus('Eroare: ' + res.error, 'err');
        }
      };
      actionsEl.appendChild(switchBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-small danger';
    delBtn.textContent = 'X';
    delBtn.title = 'Sterge contul';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Stergi contul "${name}"?`)) return;
      await send({ action: 'delete', accountName: name });
      setStatus('Cont sters.', 'ok');
      await loadAccounts();
    };
    actionsEl.appendChild(delBtn);

    row.appendChild(nameEl);
    row.appendChild(actionsEl);

    // Click pe rand = switch direct
    if (name !== active) {
      row.onclick = async () => {
        setStatus('Se face switch...');
        const res = await send({ action: 'switch', accountName: name });
        if (res.ok) {
          setStatus('Switched la: ' + name, 'ok');
          await loadAccounts();
        } else {
          setStatus('Eroare: ' + res.error, 'err');
        }
      };
    }

    list.appendChild(row);
  }
}

// Buton salveaza cont curent
document.getElementById('btn-save').onclick = () => {
  const inp = document.getElementById('save-input');
  inp.style.display = inp.style.display === 'none' ? 'block' : 'none';
  if (inp.style.display === 'block') {
    document.getElementById('account-name').focus();
  }
};

document.getElementById('btn-confirm-save').onclick = async () => {
  const name = document.getElementById('account-name').value.trim();
  if (!name) { setStatus('Introdu un nume!', 'err'); return; }

  setStatus('Se salveaza...');
  const res = await send({ action: 'save', accountName: name });
  if (res.ok) {
    document.getElementById('account-name').value = '';
    document.getElementById('save-input').style.display = 'none';
    setStatus('Cont salvat: ' + name, 'ok');
    await loadAccounts();
  } else {
    setStatus('Eroare la salvare.', 'err');
  }
};

// Enter in input = salveaza
document.getElementById('account-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-confirm-save').click();
});

// Buton deschide Claude
document.getElementById('btn-open').onclick = () => {
  chrome.tabs.create({ url: 'https://claude.ai' });
};

// Init
loadAccounts();

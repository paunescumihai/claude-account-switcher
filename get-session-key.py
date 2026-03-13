"""
Extrage sessionKey cookie din Chrome pentru claude.ai si salveaza in widget electron-store.
Usage: python get-session-key.py <profile_dir> [account_name]
"""
import sys, os, json, shutil, sqlite3, tempfile, base64, struct
from pathlib import Path

CHROME_USER_DATA = Path(os.environ['LOCALAPPDATA']) / 'Google/Chrome/User Data'
ACCOUNTS_DIR     = Path(os.environ['USERPROFILE']) / '.claude/accounts'
WIDGET_STORE_DIR = Path(os.environ['APPDATA']) / 'claude-usage-widget'
WIDGET_STORE     = WIDGET_STORE_DIR / 'config.json'

def get_chrome_key():
    local_state = CHROME_USER_DATA / 'Local State'
    data = json.loads(local_state.read_text(encoding='utf-8'))
    encrypted_key = base64.b64decode(data['os_crypt']['encrypted_key'])[5:]  # strip DPAPI prefix
    import win32crypt
    return win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]

def decrypt_cookie(encrypted, key):
    try:
        if encrypted[:3] == b'v10' or encrypted[:3] == b'v11':
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            iv = encrypted[3:15]
            payload = encrypted[15:]
            return AESGCM(key).decrypt(iv, payload, None).decode('utf-8')
        else:
            import win32crypt
            return win32crypt.CryptUnprotectData(encrypted, None, None, None, 0)[1].decode('utf-8')
    except:
        return None

def get_session_key(profile_dir):
    cookies_path = CHROME_USER_DATA / profile_dir / 'Network/Cookies'
    if not cookies_path.exists():
        cookies_path = CHROME_USER_DATA / profile_dir / 'Cookies'
    if not cookies_path.exists():
        print(f"Nu s-a gasit cookies pentru {profile_dir}", file=sys.stderr)
        return None, None

    key = get_chrome_key()

    # Copiem DB pentru ca Chrome il tine locked
    tmp = tempfile.mktemp(suffix='.db')
    shutil.copy2(cookies_path, tmp)

    session_key = None
    org_id = None
    try:
        conn = sqlite3.connect(tmp)
        cursor = conn.execute(
            "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%'"
        )
        for name, enc_val in cursor.fetchall():
            val = decrypt_cookie(enc_val, key)
            if name == 'sessionKey' and val:
                session_key = val
            if name == '__Host-CH-prefers-color-scheme' and val:
                pass  # nu ne trebuie
        conn.close()
    finally:
        os.unlink(tmp)

    return session_key, org_id

def save_to_widget_store(session_key, org_id=None):
    WIDGET_STORE_DIR.mkdir(parents=True, exist_ok=True)
    store = {}
    if WIDGET_STORE.exists():
        try:
            store = json.loads(WIDGET_STORE.read_text(encoding='utf-8'))
        except:
            pass
    store['sessionKey'] = session_key
    if org_id:
        store['organizationId'] = org_id
    WIDGET_STORE.write_text(json.dumps(store, indent=2), encoding='utf-8')
    print(f"sessionKey salvat in widget store")

def save_for_account(account_name, session_key, org_id=None):
    data = {'sessionKey': session_key}
    if org_id:
        data['organizationId'] = org_id
    dest = ACCOUNTS_DIR / f"{account_name}.widget.json"
    dest.write_text(json.dumps(data, indent=2), encoding='utf-8')
    print(f"Widget session salvata pentru contul '{account_name}'")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python get-session-key.py <profile_dir> [account_name]")
        sys.exit(1)

    profile_dir = sys.argv[1]
    account_name = sys.argv[2] if len(sys.argv) > 2 else None

    print(f"Extrag sessionKey din profil Chrome: {profile_dir}")
    session_key, org_id = get_session_key(profile_dir)

    if not session_key:
        print("EROARE: Nu s-a gasit sessionKey. Asigura-te ca esti logat pe claude.ai in Chrome.", file=sys.stderr)
        sys.exit(1)

    print(f"sessionKey gasit: {session_key[:20]}...")
    save_to_widget_store(session_key, org_id)

    if account_name:
        save_for_account(account_name, session_key, org_id)

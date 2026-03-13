"""
Verifica daca userul e logat pe claude.ai si iCloud in profilul Chrome specificat.
Output (ultima linie): JSON {"claudeLoggedIn": bool, "icloudLoggedIn": bool, "claudeEmail": str|null}
Usage: python check-cookies.py <profile_dir> [icloud_email]
"""
import sys, os, json, shutil, sqlite3, tempfile, base64
from pathlib import Path

CHROME_USER_DATA = Path(os.environ['LOCALAPPDATA']) / 'Google/Chrome/User Data'
PROFILE_DIR  = sys.argv[1] if len(sys.argv) > 1 else 'Default'
ICLOUD_EMAIL = sys.argv[2] if len(sys.argv) > 2 else ''

def get_chrome_key():
    try:
        local_state = CHROME_USER_DATA / 'Local State'
        data = json.loads(local_state.read_text(encoding='utf-8'))
        encrypted_key = base64.b64decode(data['os_crypt']['encrypted_key'])[5:]
        import win32crypt
        return win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]
    except:
        return None

def decrypt_cookie(encrypted, key):
    if not encrypted:
        return None
    try:
        if encrypted[:3] in (b'v10', b'v11'):
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            iv = encrypted[3:15]
            payload = encrypted[15:]
            return AESGCM(key).decrypt(iv, payload, None).decode('utf-8')
        else:
            import win32crypt
            return win32crypt.CryptUnprotectData(encrypted, None, None, None, 0)[1].decode('utf-8')
    except:
        return None

def get_cookies(profile_dir):
    cookies_path = CHROME_USER_DATA / profile_dir / 'Network/Cookies'
    if not cookies_path.exists():
        cookies_path = CHROME_USER_DATA / profile_dir / 'Cookies'
    if not cookies_path.exists():
        return {}

    key = get_chrome_key()
    tmp = tempfile.mktemp(suffix='.db')

    # Chrome tine fisierul locked — folosim ctypes cu FILE_SHARE_READ
    try:
        import ctypes, ctypes.wintypes as wt
        GENERIC_READ       = 0x80000000
        FILE_SHARE_READ    = 0x00000001
        FILE_SHARE_WRITE   = 0x00000002
        FILE_SHARE_DELETE  = 0x00000004
        OPEN_EXISTING      = 3
        FILE_ATTRIBUTE_NORMAL = 0x80
        kernel32 = ctypes.windll.kernel32
        h = kernel32.CreateFileW(
            str(cookies_path), GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None
        )
        if h == wt.HANDLE(-1).value:
            raise OSError("Nu pot deschide Cookies")
        size = os.path.getsize(cookies_path)
        buf  = (ctypes.c_char * size)()
        read = wt.DWORD(0)
        kernel32.ReadFile(h, buf, size, ctypes.byref(read), None)
        kernel32.CloseHandle(h)
        with open(tmp, 'wb') as f:
            f.write(bytes(buf)[:read.value])
    except Exception:
        shutil.copy2(cookies_path, tmp)

    # Copiaza si WAL file daca exista (SQLite WAL mode)
    wal_src = Path(str(cookies_path) + '-wal')
    if wal_src.exists():
        try: shutil.copy2(wal_src, tmp + '-wal')
        except: pass

    result = {}
    try:
        conn = sqlite3.connect(tmp)
        rows = conn.execute(
            "SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%' OR host_key LIKE '%icloud.com%' OR host_key LIKE '%apple.com%'"
        ).fetchall()
        conn.close()
        for host, name, enc_val in rows:
            # Prezenta cookie-ului e suficienta, decriptarea e optionala
            val = decrypt_cookie(enc_val, key) if (key and enc_val) else '__present__'
            if not val:
                val = '__present__'
            if host not in result:
                result[host] = {}
            result[host][name] = val
    except:
        pass
    finally:
        try: os.unlink(tmp)
        except: pass

    return result

def check_login():
    cookies = get_cookies(PROFILE_DIR)

    # Claude.ai: sessionKey cookie = logat
    claude_logged_in = False
    claude_email = None
    for host, cks in cookies.items():
        if 'claude.ai' in host:
            if cks.get('sessionKey'):
                claude_logged_in = True
            if cks.get('__Secure-next-auth.session-token'):
                claude_logged_in = True

    # Incearca sa ia email-ul din profilul Chrome
    try:
        ls = json.loads((CHROME_USER_DATA / 'Local State').read_text(encoding='utf-8'))
        profile_info = ls.get('profile', {}).get('info_cache', {}).get(PROFILE_DIR, {})
        claude_email = profile_info.get('user_name') or None
    except:
        pass

    # iCloud: orice cookie de autentificare Apple/iCloud = logat
    icloud_logged_in = False
    for host, cks in cookies.items():
        if 'icloud.com' in host or 'apple.com' in host:
            if any(k in cks for k in [
                'X-APPLE-WEBAUTH-USER', 'myacinfo', 'DSID',
                'X-APPLE-WEBAUTH-TOKEN', 'X-APPLE-WEBAUTH-HSA-TRUST',
                'X-APPLE-WEB-ID', 'X_APPLE_WEB_KB'
            ]):
                icloud_logged_in = True

    # Daca avem email icloud specificat, verifica si daca e acelasi cont
    # (nu putem verifica exact din cookies, dar prezenta lor e suficienta)

    return {
        'claudeLoggedIn': claude_logged_in,
        'icloudLoggedIn': icloud_logged_in,
        'claudeEmail': claude_email
    }

if __name__ == '__main__':
    result = check_login()
    print(json.dumps(result))

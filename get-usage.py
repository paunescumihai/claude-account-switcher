"""
Fetch Claude usage data from claude.ai API using Chrome session cookie.
Usage: python get-usage.py <profile_dir>
Output: JSON to stdout
"""
import sys, os, json, shutil, sqlite3, tempfile, base64
from pathlib import Path

CHROME_USER_DATA = Path(os.environ['LOCALAPPDATA']) / 'Google/Chrome/User Data'

def get_chrome_key():
    local_state = CHROME_USER_DATA / 'Local State'
    data = json.loads(local_state.read_text(encoding='utf-8'))
    encrypted_key = base64.b64decode(data['os_crypt']['encrypted_key'])[5:]
    import win32crypt
    return win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]

def decrypt_cookie(encrypted, key):
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
    uri = 'file:' + str(cookies_path).replace('\\', '/') + '?immutable=1&mode=ro'

    result = {}
    try:
        conn = sqlite3.connect(uri, uri=True)
        for name, enc_val in conn.execute(
            "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%'"
        ).fetchall():
            val = decrypt_cookie(enc_val, key)
            if val:
                result[name] = val
        conn.close()
    except Exception as e:
        print(f"Eroare citire cookies: {e}", file=sys.stderr)

    return result

def fetch_usage(profile_dir):
    import urllib.request, urllib.error

    cookies = get_cookies(profile_dir)
    session_key = cookies.get('sessionKey', '')
    if not session_key:
        print(json.dumps({'error': 'no sessionKey'}))
        return

    cookie_header = '; '.join(f'{k}={v}' for k, v in cookies.items())

    headers = {
        'Cookie': cookie_header,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://claude.ai/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
    }

    def api_get(url):
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode('utf-8'))

    # Get org ID
    orgs = api_get('https://claude.ai/api/organizations')
    if not orgs or not isinstance(orgs, list):
        print(json.dumps({'error': 'cannot get org'}))
        return
    org_id = orgs[0].get('uuid') or orgs[0].get('id')
    if not org_id:
        print(json.dumps({'error': 'no org id'}))
        return

    # Get usage
    usage = api_get(f'https://claude.ai/api/organizations/{org_id}/usage')

    # Try overage (optional)
    overage = None
    try:
        overage = api_get(f'https://claude.ai/api/organizations/{org_id}/overage_spend_limit')
    except:
        pass

    result = {'usage': usage, 'org_id': org_id}
    if overage:
        result['overage'] = overage

    print(json.dumps(result))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: python get-usage.py <profile_dir>'}))
        sys.exit(1)
    fetch_usage(sys.argv[1])

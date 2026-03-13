"""
Refresheaza OAuth token folosind refreshToken din credentials.json
Usage: python refresh-token.py [credentials_file]
"""
import sys, json, urllib.request, urllib.parse, os
from pathlib import Path

CREDS_FILE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ['USERPROFILE']) / '.claude/.credentials.json'

def refresh_token(creds_path):
    data = json.loads(Path(creds_path).read_text(encoding='utf-8'))
    oauth = data.get('claudeAiOauth', {})
    refresh_tok = oauth.get('refreshToken')
    if not refresh_tok:
        print("EROARE: Nu s-a gasit refreshToken", file=sys.stderr)
        return False

    import time
    expires_at = oauth.get('expiresAt', 0)
    if expires_at > time.time() * 1000 + 60000:
        print("Token inca valid, nu e nevoie de refresh")
        return True

    payload = json.dumps({
        "grant_type": "refresh_token",
        "refresh_token": refresh_tok
    }).encode('utf-8')

    req = urllib.request.Request(
        'https://claude.ai/oauth/token',
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'User-Agent': 'Claude-Code/1.0'
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        print(f"EROARE HTTP {e.code}: {body}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"EROARE: {e}", file=sys.stderr)
        return False

    if 'access_token' in result:
        oauth['accessToken'] = result['access_token']
        if 'refresh_token' in result:
            oauth['refreshToken'] = result['refresh_token']
        if 'expires_in' in result:
            import time
            oauth['expiresAt'] = int((time.time() + result['expires_in']) * 1000)
        data['claudeAiOauth'] = oauth
        Path(creds_path).write_text(json.dumps(data), encoding='utf-8')
        print(f"Token refreshed cu succes. Expira in: {result.get('expires_in', '?')}s")
        return True
    else:
        print(f"EROARE: Raspuns neasteptat: {result}", file=sys.stderr)
        return False

if not refresh_token(CREDS_FILE):
    sys.exit(1)

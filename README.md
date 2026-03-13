# Claude Account Switcher

Switch automat între conturi Claude când se termină creditele zilnice.

## Setup

### 1. Clonează repo-ul
```powershell
git clone https://github.com/YOUR_USERNAME/claude-account-switcher.git
cd claude-account-switcher
```

### 2. Rulează scriptul
```powershell
powershell -ExecutionPolicy Bypass -File switch.ps1
```

### 3. Adaugă conturile tale
- Loghează-te cu primul cont: `claude` (în terminal)
- În meniu alege **[A]** și dă-i un nume (ex: `cont1`)
- Fă logout: `claude logout`
- Loghează-te cu al doilea cont și repetă pasul de mai sus cu numele `cont2`

### 4. Instalează hook-ul auto-switch
- În meniu alege **[I]** — hook-ul se instalează în Claude settings
- De acum, când un cont atinge limita, Claude face switch automat la următorul

## Cum funcționează

```
accounts/
├── cont1.json     ← credențiale cont 1
├── cont2.json     ← credențiale cont 2
└── .active        ← numele contului activ
```

- `switch.ps1` — meniu interactiv pentru gestionarea conturilor
- `auto-switch-hook.ps1` — hook rulat de Claude Code la fiecare Stop event; detectează mesaje de rate limit și face switch automat

## Meniu

| Opțiune | Acțiune |
|---------|---------|
| A | Salvează contul curent logat |
| S | Switch manual la un alt cont |
| N | Switch imediat la următorul cont |
| D | Șterge un cont salvat |
| I | Instalează hook auto-switch |
| U | Dezinstalează hook |

## Notă de securitate

Fișierele `.json` cu credențiale sunt salvate local în `~/.claude/accounts/` și **nu sunt incluse în repo**.

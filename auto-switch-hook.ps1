# Auto-Switch Hook - ruleaza la fiecare Stop event din Claude Code
# Citeste inputul JSON de la Claude, detecteaza rate limit si face switch automat

$input_json = $env:CLAUDE_HOOK_INPUT
if ([string]::IsNullOrEmpty($input_json)) { exit 0 }

try {
    $data = $input_json | ConvertFrom-Json
} catch { exit 0 }

# Mesaje care indica ca s-au terminat creditele
$rateLimitPatterns = @(
    "rate limit",
    "usage limit",
    "exceeded.*limit",
    "too many requests",
    "quota exceeded",
    "daily limit",
    "out of credits",
    "402",
    "529"
)

# Verifica daca exista mesaje de rate limit in transcript sau notificare
$textToCheck = ($data | ConvertTo-Json -Depth 5).ToLower()

$isRateLimited = $false
foreach ($pattern in $rateLimitPatterns) {
    if ($textToCheck -match $pattern) {
        $isRateLimited = $true
        break
    }
}

if (-not $isRateLimited) { exit 0 }

# --- Rate limit detectat, facem switch ---
$ACCOUNTS_DIR = "$env:USERPROFILE\.claude\accounts"
$CREDS_FILE   = "$env:USERPROFILE\.claude\.credentials.json"

$accounts = Get-ChildItem "$ACCOUNTS_DIR\*.json" -ErrorAction SilentlyContinue
if ($accounts.Count -le 1) {
    Write-Host '{"continue": true, "reason": "Rate limit atins dar nu sunt alte conturi disponibile."}'
    exit 0
}

$activeFile = "$ACCOUNTS_DIR\.active"
$active     = if (Test-Path $activeFile) { Get-Content $activeFile } else { "" }
$names      = $accounts | ForEach-Object { $_.BaseName }

$currentIdx = [array]::IndexOf($names, $active)
$nextIdx    = ($currentIdx + 1) % $names.Count
$nextName   = $names[$nextIdx]

# Fa switch-ul
Copy-Item "$ACCOUNTS_DIR\$nextName.json" $CREDS_FILE -Force
Set-Content -Path $activeFile -Value $nextName

# Returneaza mesaj catre Claude (format JSON pentru hook)
$msg = "Rate limit atins pe contul '$active'. Am facut switch automat la contul '$nextName'. Poti continua."
Write-Host "{`"continue`": true, `"reason`": `"$msg`"}"
exit 0

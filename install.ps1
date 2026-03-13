# install.ps1 — Setup complet dupa clonarea repo-ului
# Folosire:
#   git clone https://github.com/paunescumihai/claude-account-switcher "%USERPROFILE%\claude-account-switcher"
#   powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\claude-account-switcher\install.ps1"

$repoDir  = $PSScriptRoot
$vsix     = "$repoDir\vscode-ext\claude-account-switcher-1.0.0.vsix"

# 1. Instaleaza extensia VSCode
$codeCli = @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:PROGRAMFILES\Microsoft VS Code\bin\code.cmd"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($codeCli -and (Test-Path $vsix)) {
    Write-Host "  Instalez extensia VSCode..." -ForegroundColor Cyan
    & $codeCli --install-extension $vsix --force 2>&1 | Out-Null
    Write-Host "✓ Extensia VSCode instalata (restart VSCode pentru a aparea)" -ForegroundColor Green
} else {
    Write-Host "! VSCode nu a fost gasit sau lipseste VSIX-ul" -ForegroundColor Yellow
}

# 3. Creeaza directorul de conturi daca nu exista
$accountsDir = "$env:USERPROFILE\.claude\accounts"
if (-not (Test-Path $accountsDir)) {
    New-Item -ItemType Directory -Path $accountsDir -Force | Out-Null
    Write-Host "✓ Director conturi creat: $accountsDir" -ForegroundColor Green
}

Write-Host ""
Write-Host "Setup complet! Pasi urmatori:" -ForegroundColor Cyan
Write-Host "  1. Restart VSCode" -ForegroundColor White
Write-Host "  2. Click pe iconita din status bar (jos-dreapta) pentru a adauga conturi" -ForegroundColor White

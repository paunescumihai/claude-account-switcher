# Claude Account Switcher

$CREDS_FILE   = "$env:USERPROFILE\.claude\.credentials.json"
$ACCOUNTS_DIR = "$env:USERPROFILE\.claude\accounts"

if (-not (Test-Path $ACCOUNTS_DIR)) {
    New-Item -ItemType Directory -Path $ACCOUNTS_DIR -Force | Out-Null
}

function Write-Color($text, $color = "White") {
    Write-Host $text -ForegroundColor $color
}

function Show-Banner {
    Clear-Host
    Write-Color "======================================" Cyan
    Write-Color "      CLAUDE ACCOUNT SWITCHER         " Cyan
    Write-Color "======================================" Cyan
    Write-Host ""
}

function Get-Accounts {
    return Get-ChildItem "$ACCOUNTS_DIR\*.json" -ErrorAction SilentlyContinue
}

function Get-ActiveAccount {
    $active = "$ACCOUNTS_DIR\.active"
    if (Test-Path $active) { return Get-Content $active }
    return $null
}

function Set-ActiveAccount($name) {
    Set-Content -Path "$ACCOUNTS_DIR\.active" -Value $name
}

function Get-AccountInfo($jsonPath) {
    try {
        $data = Get-Content $jsonPath -Raw | ConvertFrom-Json
        $oauth = $data.claudeAiOauth
        $plan  = $oauth.subscriptionType
        $tier  = $oauth.rateLimitTier
        $exp   = $oauth.expiresAt
        $expDate = [DateTimeOffset]::FromUnixTimeMilliseconds($exp).LocalDateTime
        $expired = if ($expDate -lt (Get-Date)) { " [TOKEN EXPIRAT]" } else { "" }
        return "$plan / $tier$expired"
    } catch {
        return "necunoscut"
    }
}

function List-Accounts {
    $accounts = Get-Accounts
    $active = Get-ActiveAccount

    if ($accounts.Count -eq 0) {
        Write-Color "  Niciun cont salvat. Adauga unul cu optiunea [A]." Yellow
        return
    }

    Write-Color "  Conturi salvate:" White
    Write-Host ""
    $i = 1
    foreach ($acc in $accounts) {
        $name = $acc.BaseName
        $info = Get-AccountInfo $acc.FullName
        $marker = ""
        $color = "White"
        if ($name -eq $active) {
            $marker = " [ACTIV]"
            $color = "Green"
        }
        Write-Color "  [$i] $name$marker" $color
        Write-Color "      $info" DarkGray
        $i++
    }
    Write-Host ""
}

function Save-CurrentAccount {
    Show-Banner
    Write-Color "  Adauga cont nou" Yellow
    Write-Host ""

    $name = Read-Host "  Numele contului (ex: paunescu@powerhost.ro)"
    if ([string]::IsNullOrWhiteSpace($name)) { return }

    # Deschide Chrome la claude.ai
    Write-Host ""
    Write-Color "  Deschid Chrome la claude.ai..." Cyan
    $chrome = @(
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe",
        "$env:PROGRAMFILES(x86)\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($chrome) {
        Start-Process $chrome "https://claude.ai"
    } else {
        Start-Process "https://claude.ai"
    }

    Write-Host ""
    Write-Color "  1. Logheaza-te pe claude.ai cu contul '$name'" Yellow
    Write-Color "  2. Click pe extensia Claude Account Switcher" Yellow
    Write-Color "  3. Click '+ Salveaza cont curent' si foloseste numele: $name" Yellow
    Write-Host ""

    if (-not (Test-Path $CREDS_FILE)) {
        Write-Color "  ATENTIE: Fa si 'claude' login in terminal pentru CLI." DarkYellow
    } else {
        Read-Host "  Apasa Enter dupa ce ai salvat in extensie pentru a salva si CLI-ul"
        Copy-Item $CREDS_FILE "$ACCOUNTS_DIR\$name.json" -Force
        Set-ActiveAccount $name
        Write-Color "  CLI salvat pentru '$name'!" Green
    }
    Start-Sleep 1
}

function Switch-Account($name) {
    $src = "$ACCOUNTS_DIR\$name.json"
    if (-not (Test-Path $src)) {
        Write-Color "  EROARE: Contul '$name' nu exista." Red
        return $false
    }
    Copy-Item $src $CREDS_FILE -Force
    Set-ActiveAccount $name
    Write-Color "  CLI switched la: $name" Green
    Write-Color "  Foloseste extensia Chrome pentru browser." DarkGray
    return $true
}

function Switch-AccountMenu {
    Show-Banner
    List-Accounts

    $accounts = Get-Accounts
    if ($accounts.Count -eq 0) { Read-Host "  Apasa Enter..."; return }

    $choice = Read-Host "  Numarul contului (sau Enter pentru anulare)"
    if ([string]::IsNullOrWhiteSpace($choice)) { return }

    $idx = [int]$choice - 1
    if ($idx -lt 0 -or $idx -ge $accounts.Count) {
        Write-Color "  Optiune invalida." Red
        Start-Sleep 1
        return
    }

    $name = $accounts[$idx].BaseName
    Switch-Account $name | Out-Null
    Start-Sleep 1
}

function Delete-Account {
    Show-Banner
    List-Accounts

    $accounts = Get-Accounts
    if ($accounts.Count -eq 0) { Read-Host "  Apasa Enter..."; return }

    $choice = Read-Host "  Numarul contului de sters (sau Enter pentru anulare)"
    if ([string]::IsNullOrWhiteSpace($choice)) { return }

    $idx = [int]$choice - 1
    if ($idx -lt 0 -or $idx -ge $accounts.Count) {
        Write-Color "  Optiune invalida." Red
        Start-Sleep 1
        return
    }

    $name = $accounts[$idx].BaseName
    Remove-Item "$ACCOUNTS_DIR\$name.json" -Force
    Write-Color "  Contul '$name' a fost sters." Yellow
    Start-Sleep 1
}

function Auto-SwitchNext {
    $accounts = Get-Accounts
    $active   = Get-ActiveAccount
    $names    = $accounts | ForEach-Object { $_.BaseName }

    if ($names.Count -le 1) {
        Write-Color "  Nu sunt destule conturi pentru auto-switch (minim 2)." Red
        return $false
    }

    $currentIdx = [array]::IndexOf($names, $active)
    $nextIdx    = ($currentIdx + 1) % $names.Count
    $nextName   = $names[$nextIdx]

    Write-Color "  AUTO-SWITCH: '$active' -> '$nextName'" Magenta
    return (Switch-Account $nextName)
}

function Install-Hook {
    $settingsFile = "$env:USERPROFILE\.claude\settings.json"
    $hookScript   = "$PSScriptRoot\auto-switch-hook.ps1"

    $settings = if (Test-Path $settingsFile) {
        Get-Content $settingsFile -Raw | ConvertFrom-Json
    } else {
        New-Object PSObject
    }

    $hookCmd = "powershell -ExecutionPolicy Bypass -File `"$hookScript`""

    $hookEntry = New-Object PSObject -Property @{
        matcher = ""
        hooks   = @(
            New-Object PSObject -Property @{
                type    = "command"
                command = $hookCmd
            }
        )
    }

    if (-not ($settings | Get-Member -Name "hooks" -MemberType NoteProperty)) {
        $settings | Add-Member -NotePropertyName "hooks" -NotePropertyValue (New-Object PSObject)
    }
    if (-not ($settings.hooks | Get-Member -Name "Stop" -MemberType NoteProperty)) {
        $settings.hooks | Add-Member -NotePropertyName "Stop" -NotePropertyValue @()
    }

    $settings.hooks.Stop = @($hookEntry)
    $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
    Write-Color "  Hook instalat in Claude settings!" Green
    Start-Sleep 1
}

function Uninstall-Hook {
    $settingsFile = "$env:USERPROFILE\.claude\settings.json"
    if (-not (Test-Path $settingsFile)) { return }

    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
    if ($settings.hooks -and ($settings.hooks | Get-Member -Name "Stop" -MemberType NoteProperty)) {
        $settings.hooks.PSObject.Properties.Remove("Stop")
    }
    $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
    Write-Color "  Hook dezinstalat." Yellow
    Start-Sleep 1
}

# ── Main Menu ──────────────────────────────────────────────────────────────────
while ($true) {
    Show-Banner
    List-Accounts

    Write-Color "  Optiuni:" White
    Write-Color "  [A] Adauga / salveaza contul curent" White
    Write-Color "  [S] Switch cont CLI" White
    Write-Color "  [N] Auto-switch la urmatorul cont" White
    Write-Color "  [D] Sterge un cont" White
    Write-Color "  [I] Instaleaza hook auto-switch (la rate limit)" White
    Write-Color "  [U] Dezinstaleaza hook" White
    Write-Color "  [Q] Iesire" White
    Write-Host ""

    $opt = Read-Host "  Alegerea ta"

    switch ($opt.ToUpper()) {
        "A" { Save-CurrentAccount }
        "S" { Switch-AccountMenu }
        "N" { Auto-SwitchNext; Start-Sleep 1 }
        "D" { Delete-Account }
        "I" { Install-Hook }
        "U" { Uninstall-Hook }
        "Q" { exit }
    }
}

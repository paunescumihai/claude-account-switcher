# Claude Account Switcher

$CREDS_FILE   = "$env:USERPROFILE\.claude\.credentials.json"
$ACCOUNTS_DIR = "$env:USERPROFILE\.claude\accounts"
$CHROME_EXE   = @(
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe",
    "${env:PROGRAMFILES(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

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

function Get-ChromeProfiles {
    $localState = "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State"
    $profiles = @()
    if (-not (Test-Path $localState)) { return $profiles }
    try {
        $data = Get-Content $localState -Raw | ConvertFrom-Json
        $cache = $data.profile.info_cache
        foreach ($dir in ($cache | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name)) {
            $info = $cache.$dir
            $profiles += [PSCustomObject]@{
                Dir   = $dir
                Name  = $info.name
                Email = $info.user_name
            }
        }
    } catch {}
    return $profiles
}

function Get-AccountProfile($name) {
    $f = "$ACCOUNTS_DIR\$name.profile"
    if (Test-Path $f) { return Get-Content $f }
    return $null
}

function Set-AccountProfile($name, $profileDir) {
    Set-Content -Path "$ACCOUNTS_DIR\$name.profile" -Value $profileDir
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
        $profDir = Get-AccountProfile $name
        $profLabel = if ($profDir) {
            $cp = Get-ChromeProfiles | Where-Object { $_.Dir -eq $profDir } | Select-Object -First 1
            $pn = if ($cp -and $cp.Name) { $cp.Name } else { $profDir }
            " | Chrome: $pn"
        } else { "" }
        $marker = ""
        $color = "White"
        if ($name -eq $active) {
            $marker = " [ACTIV]"
            $color = "Green"
        }
        Write-Color "  [$i] $name$marker" $color
        Write-Color "      $info$profLabel" DarkGray
        $i++
    }
    Write-Host ""
}

function Pick-ChromeProfile {
    $profiles = Get-ChromeProfiles
    if ($profiles.Count -eq 0) {
        Write-Color "  Nu s-au gasit profiluri Chrome." Red
        return $null
    }

    Write-Host ""
    Write-Color "  Profiluri Chrome disponibile:" White
    $i = 1
    foreach ($p in $profiles) {
        $label = if ($p.Name) { $p.Name } else { $p.Dir }
        if ($p.Email) { $label += " - $($p.Email)" }
        Write-Color "  [$i] $label" White
        $i++
    }
    Write-Host ""

    $choice = Read-Host "  Alege profilul Chrome pentru acest cont"
    if ([string]::IsNullOrWhiteSpace($choice)) { return $null }

    $idx = [int]$choice - 1
    if ($idx -lt 0 -or $idx -ge $profiles.Count) { return $null }
    return $profiles[$idx].Dir
}

function Open-ChromeProfile($profileDir) {
    if (-not $CHROME_EXE) {
        Start-Process "https://claude.ai"
        return
    }
    if ($profileDir) {
        Start-Process $CHROME_EXE "--profile-directory=`"$profileDir`" https://claude.ai"
    } else {
        Start-Process $CHROME_EXE "https://claude.ai"
    }
}

function Save-CurrentAccount {
    Show-Banner
    Write-Color "  Adauga cont nou" Yellow
    Write-Host ""

    $name = Read-Host "  Numele contului (ex: paunescu@powerhost.ro)"
    if ([string]::IsNullOrWhiteSpace($name)) { return }

    $profileDir = Pick-ChromeProfile

    Write-Host ""
    Write-Color "  Deschid Chrome..." Cyan
    Open-ChromeProfile $profileDir

    Write-Host ""
    Write-Color "  1. Logheaza-te pe claude.ai cu contul '$name'" Yellow
    Write-Color "  2. Click pe extensia Claude Account Switcher" Yellow
    Write-Color "  3. Click '+ Salveaza cont curent' si foloseste numele: $name" Yellow
    Write-Host ""

    Read-Host "  Apasa Enter dupa ce ai salvat in extensie (pentru a salva si CLI-ul)"

    if (Test-Path $CREDS_FILE) {
        Copy-Item $CREDS_FILE "$ACCOUNTS_DIR\$name.json" -Force
        if ($profileDir) { Set-AccountProfile $name $profileDir }
        Set-ActiveAccount $name
        Save-WidgetSession $name
        Write-Color "  Cont '$name' salvat!" Green
    } else {
        Write-Color "  ATENTIE: Nu s-a gasit fisier CLI. Fa 'claude' login in terminal." DarkYellow
    }
    Start-Sleep 1
}

function Update-VSCodeTitle($name) {
    $vsSettings = "$env:APPDATA\Code\User\settings.json"
    if (-not (Test-Path $vsSettings)) { return }
    try {
        $s = Get-Content $vsSettings -Raw | ConvertFrom-Json
        $title = "${name} | `${activeEditorShort}`${separator}`${rootName}"
        if ($s | Get-Member -Name "window.title" -MemberType NoteProperty) {
            $s."window.title" = $title
        } else {
            $s | Add-Member -NotePropertyName "window.title" -NotePropertyValue $title
        }
        $json = $s | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($vsSettings, $json, (New-Object System.Text.UTF8Encoding $false))
    } catch {}
}

$WIDGET_STORE = "$env:APPDATA\claude-usage-widget\config.json"
$ELECTRON_EXE = "$env:USERPROFILE\claude-usage-widget-app\node_modules\.bin\electron.cmd"

$PYTHON_EXE     = "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe"
$GET_SESSION_PY = "$PSScriptRoot\get-session-key.py"

function Save-WidgetSession($name) {
    # Incearca sa extraga sessionKey din Chrome
    $profDir = Get-AccountProfile $name
    if ($profDir -and (Test-Path $PYTHON_EXE) -and (Test-Path $GET_SESSION_PY)) {
        Write-Color "  Extrag sessionKey din Chrome..." Cyan
        & $PYTHON_EXE $GET_SESSION_PY $profDir $name 2>&1 | ForEach-Object { Write-Color "  $_" DarkGray }
    } elseif (Test-Path $WIDGET_STORE) {
        Copy-Item $WIDGET_STORE "$ACCOUNTS_DIR\$name.widget.json" -Force
        Write-Color "  Sesiune widget salvata pentru '$name'" Green
    }
}

function Restore-WidgetSession($name) {
    # Incearca intai sa extraga fresh din Chrome
    $profDir = Get-AccountProfile $name
    if ($profDir -and (Test-Path $PYTHON_EXE) -and (Test-Path $GET_SESSION_PY)) {
        Write-Color "  Extrag sessionKey din Chrome pentru '$name'..." Cyan
        & $PYTHON_EXE $GET_SESSION_PY $profDir $name 2>&1 | ForEach-Object { Write-Color "  $_" DarkGray }
        return $true
    }
    # Fallback: restaureaza din backup
    $saved = "$ACCOUNTS_DIR\$name.widget.json"
    if (Test-Path $saved) {
        $dir = Split-Path $WIDGET_STORE
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item $saved $WIDGET_STORE -Force
        return $true
    }
    return $false
}

function Launch-Widget {
    $widgetDir = "$env:USERPROFILE\claude-usage-widget-app"
    if (-not (Test-Path $widgetDir)) {
        Write-Color "  Widget nu e instalat la $widgetDir" Red
        return
    }
    Get-Process -Name "electron*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Start-Process $ELECTRON_EXE -ArgumentList $widgetDir -WindowStyle Normal
    Write-Color "  Widget lansat!" Green
}

function Switch-Account($name) {
    $src = "$ACCOUNTS_DIR\$name.json"
    if (-not (Test-Path $src)) {
        Write-Color "  EROARE: Contul '$name' nu exista." Red
        return $false
    }
    Copy-Item $src $CREDS_FILE -Force
    Set-ActiveAccount $name
    Update-VSCodeTitle $name
    $restored = Restore-WidgetSession $name
    Launch-Widget
    if (-not $restored) { Write-Color "  (Widgetul va cere login pentru acest cont)" DarkGray }
    Write-Color "  CLI switched la: $name" Green

    $profileDir = Get-AccountProfile $name
    if ($profileDir) {
        Write-Color "  Deschid Chrome ($profileDir)..." Cyan
        Open-ChromeProfile $profileDir
    } else {
        Write-Color "  (Niciun profil Chrome asociat)" DarkGray
    }
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
    Remove-Item "$ACCOUNTS_DIR\$name.profile" -Force -ErrorAction SilentlyContinue
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
    Write-Color "  [A] Adauga cont nou" White
    Write-Color "  [S] Switch cont (CLI + deschide profilul Chrome)" White
    Write-Color "  [N] Auto-switch la urmatorul cont" White
    Write-Color "  [D] Sterge un cont" White
    Write-Color "  [W] Lanseaza Usage Widget" White
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
        "W" { Launch-Widget; Start-Sleep 1 }
        "I" { Install-Hook }
        "U" { Uninstall-Hook }
        "Q" { exit }
    }
}

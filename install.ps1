# install.ps1 — Creeaza shortcut-ul pe desktop dupa clonarea repo-ului

$repoDir  = $PSScriptRoot
$iconPath = "$repoDir\icon.ico"
$lnkPath  = "$env:USERPROFILE\Desktop\ClaudeSwitch.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath       = "powershell.exe"
$lnk.Arguments        = "-NoExit -ExecutionPolicy Bypass -File `"$repoDir\switch.ps1`""
$lnk.WorkingDirectory = $repoDir
$lnk.WindowStyle      = 1
$lnk.IconLocation     = $iconPath
$lnk.Description      = "Claude Account Switcher"
$lnk.Save()

Write-Host "Shortcut creat pe desktop: ClaudeSwitch" -ForegroundColor Green

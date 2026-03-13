$vsSettings = "$env:APPDATA\Code\User\settings.json"
$name = (Get-Content "$env:USERPROFILE\.claude\accounts\.active" -ErrorAction SilentlyContinue).Trim()
if (-not $name) { $name = "unknown" }

$s = Get-Content $vsSettings -Raw | ConvertFrom-Json
$title = "[$name] `${activeEditorShort}`${separator}`${rootName}"

if ($s | Get-Member -Name "window.title" -MemberType NoteProperty) {
    $s."window.title" = $title
} else {
    $s | Add-Member -NotePropertyName "window.title" -NotePropertyValue $title
}
$json = $s | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($vsSettings, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Done: $title"

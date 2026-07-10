# Creates / refreshes the "DevWebUI" shortcut in the project root. The shortcut
# launches misc\DevWebUI.vbs (system tray) and carries the DevWebUI icon, so the
# root has one nice clickable entry instead of a bare .vbs.
# Re-run this if you move or rename the project folder.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir
$lnk = Join-Path $root "DevWebUI.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
# Run the .vbs through wscript explicitly (no console window, no file-association surprises).
$sc.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$sc.Arguments = '"' + (Join-Path $scriptDir "DevWebUI.vbs") + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation = (Join-Path $scriptDir "DevWebUI.ico") + ",0"
$sc.Description = "Launch DevWebUI (system tray)"
$sc.Save()
Write-Host "Created shortcut: $lnk"

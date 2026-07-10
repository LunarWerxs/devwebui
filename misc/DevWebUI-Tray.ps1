# DevWebUI system-tray host (Windows). Runs the daemon with NO console window and
# shows a tray icon with Open / Rebuild & Restart / Restart / Quit. Launch it via
# DevWebUI.vbs (which sets the port) so there's no console flash. The daemon serves
# the built GUI + API on one port. The shortcut launches FAST with the existing build;
# use the tray's "Rebuild & Restart" to rebuild the GUI from source and restart the
# daemon. This script lives in misc/, so the project root is one level up.
#
# Port handling: -Port is the PREFERRED port. If it's busy, the daemon picks the next
# free port itself and records where it landed in ~/.devwebui/runtime.json — so this
# script never assumes the port; it reads the real URL from there (validated by a
# /api/health probe) and opens that.
#
# Responsiveness: "Rebuild & Restart" and "Restart" do their slow work (bun build,
# graceful shutdown — which can wait up to ~25s — and the readiness poll) on a
# BACKGROUND runspace, and a WinForms timer marshals the result back to the UI
# thread, so the tray never freezes. Daemon control is stateless — it locates the
# live instance via the runtime pointer + /api/health, shuts it down gracefully with
# the session token (force-killing the port only as a fallback), and works the same
# on the UI thread and in the worker, surviving repeated restarts.
param([int]$Port = 4000, [switch]$SelfTest)
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir
Set-Location $root

# Dev-only gate for the "Rebuild & Restart" menu item (see its DEV-ONLY comment below): a
# distributed build ships a prebuilt web\dist and no `server\src` tree to rebuild from, so
# offering that menu item there would just fail. True when either the source tree is present
# (this script is running from a checkout, not a bare distribution) or DEVWEBUI_DEV=1 is set
# (explicit override for a dev machine laid out unusually).
$script:isDevTree = ($env:DEVWEBUI_DEV -eq "1") -or (Test-Path (Join-Path $root "server\src"))

# Headless self-test (tests/launcher.test.ts). Proves the tray can actually start —
# bun on PATH, the daemon entry exists, and the icon LOADS into a real NotifyIcon —
# then exits WITHOUT opening a browser or entering the message loop. A missing/corrupt
# icon (the classic "tray icon is broken") makes this exit non-zero.
if ($SelfTest) {
  $fail = @()
  if (-not (Get-Command bun -ErrorAction SilentlyContinue))            { $fail += "bun not on PATH" }
  if (-not (Test-Path (Join-Path $root "server\src\index.ts")))         { $fail += "daemon entry server\src\index.ts missing" }
  $icoPath = Join-Path $scriptDir "DevWebUI.ico"
  if (-not (Test-Path $icoPath)) {
    $fail += "tray icon DevWebUI.ico missing"
  } else {
    try {
      # Load the TRAY-sized frame (not the 256 jumbo) and force a decode — this catches a
      # 256-only icon, which renders blank in the tray (the classic "tray icon is broken").
      $ico = New-Object System.Drawing.Icon($icoPath, [System.Windows.Forms.SystemInformation]::SmallIconSize)
      $null = $ico.ToBitmap()                            # forces decode of the chosen frame
      $ni  = New-Object System.Windows.Forms.NotifyIcon  # the actual tray-icon object
      $ni.Icon = $ico                                    # must accept the icon
      $ni.Dispose(); $ico.Dispose()
      # The tray needs a small frame; a 256-only .ico has none. Require one (<=48px).
      $icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
      $frameCount = [BitConverter]::ToUInt16($icoBytes, 4); $hasSmallFrame = $false
      for ($fi = 0; $fi -lt $frameCount; $fi++) { $fw = $icoBytes[6 + $fi*16]; if ($fw -ne 0 -and $fw -le 48) { $hasSmallFrame = $true } }
      if (-not $hasSmallFrame) { $fail += "tray icon has no small (<=48px) frame; a 256-only icon renders blank" }
    } catch { $fail += "tray icon failed to load: $($_.Exception.Message)" }
  }
  if ($fail.Count) { Write-Output ("DEVWEBUI_TRAY_SELFTEST_FAIL: " + ($fail -join "; ")); exit 1 }
  Write-Output "DEVWEBUI_TRAY_SELFTEST_OK"; exit 0
}
$port = $Port
$env:DEVWEBUI_PORT = "$Port"   # the daemon (bun server) reads this as its PREFERRED port
$infoFile = Join-Path $env:USERPROFILE ".devwebui\runtime.json"
# Current live URL — updated whenever we (re)start the daemon. Script-scoped so the
# tray menu handlers always open wherever the daemon actually is now.
$script:url = "http://localhost:$port"
$script:shutdownToken = [System.Guid]::NewGuid().ToString("N")
# Tracks whether this tray launched the daemon itself; attached daemons are left alone
# when the tray exits.
$script:startedByUs = $false
# Shared with the worker runspace (same process heap): the worker records the PIDs it
# spawns so Quit can reap them, and Quit sets `cancel` to stop the worker early.
$script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })

# --- Daemon control ---------------------------------------------------------------
# Defined once as a scriptblock so the exact same functions run on the UI thread
# (launch, quit) AND inside the background worker runspace (rebuild, restart). All
# stateless: they locate the live instance via the runtime pointer + /api/health and
# shut it down with the session token, so nothing depends on a shared Process handle.
$DevControl = {
  # Is a DevWebUI daemon answering here? (Distinguishes "our app is up" from "some
  # unrelated process happens to hold the port".)
  function Test-DevWebUI($u) {
    if (-not $u) { return $false }
    try {
      $r = Invoke-RestMethod -Uri "$u/api/health" -TimeoutSec 1 -ErrorAction Stop
      return [bool]$r.ok
    } catch { return $false }
  }
  # The URL of a live DevWebUI instance (runtime pointer, else preferred port), or $null.
  function Get-RunningUrl($infoFile, $port) {
    if (Test-Path $infoFile) {
      try {
        $info = Get-Content $infoFile -Raw | ConvertFrom-Json
        if ($info.url -and (Test-DevWebUI $info.url)) { return $info.url }
      } catch { }
    }
    $u = "http://localhost:$port"
    if (Test-DevWebUI $u) { return $u }
    return $null
  }
  function Get-PortFromUrl($u) { try { return ([uri]$u).Port } catch { return 0 } }
  # Plain `netstat -ano` (no `-p tcp`) so IPv4 AND IPv6 listeners are both included.
  function Get-PortPids([int]$p) {
    $ids = @()
    try {
      foreach ($line in (& netstat -ano 2>$null)) {
        $t = $line.Trim()
        if ($t -notmatch 'LISTENING') { continue }
        $parts = $t -split '\s+'
        if ($parts.Length -ge 5 -and $parts[1] -match (':' + $p + '$') -and $parts[4] -match '^\d+$') { $ids += [int]$parts[4] }
      }
    } catch {}
    return ($ids | Select-Object -Unique)
  }
  # Ask the daemon to shut itself down cleanly (token-gated; only a daemon we started
  # this session honours our token).
  function Invoke-DaemonShutdown($u, $token, $timeoutSec = 20) {
    if (-not $u) { return $false }
    try {
      Invoke-RestMethod -Uri "$u/api/shutdown" -Method Post `
        -Headers @{ "x-devwebui-shutdown-token" = $token; "x-devwebui-shutdown-source" = "ui" } `
        -TimeoutSec $timeoutSec -ErrorAction Stop | Out-Null
      return $true
    } catch { return $false }
  }
  # Stop the live daemon: graceful shutdown first; force-kill the port owner only as a
  # fallback, and only when $forceKill is set (so Quit won't kill an attached daemon
  # that another session owns).
  function Stop-DevWebUI($infoFile, $port, $token, $forceKill) {
    $u = Get-RunningUrl $infoFile $port
    if (-not $u) { return }
    # Only act on a daemon we own ($forceKill). Otherwise leave an attached instance
    # alone — including the graceful shutdown (the server accepts the 'ui' source
    # regardless of token, so a graceful call is NOT a safe no-op for a daemon we don't own).
    if (-not $forceKill) { return }
    if (Invoke-DaemonShutdown $u $token) {
      for ($i = 0; $i -lt 40; $i++) {
        if (-not (Get-RunningUrl $infoFile $port)) { return }
        Start-Sleep -Milliseconds 250
      }
    }
    $ports = @($port); $pp = Get-PortFromUrl $u; if ($pp -gt 0) { $ports += $pp }
    foreach ($pp in ($ports | Select-Object -Unique)) {
      foreach ($procId in (Get-PortPids $pp)) { if ($procId -gt 0) { & taskkill /PID $procId /T /F 2>$null | Out-Null } }
    }
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Get-RunningUrl $infoFile $port)) { return }
      Start-Sleep -Milliseconds 200
    }
  }
  function Start-DevWebUI($appRoot, $port, $token) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c bun server/src/index.ts"
    $psi.WorkingDirectory = $appRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = "Hidden"
    $psi.EnvironmentVariables["DEVWEBUI_PORT"] = "$port"
    $psi.EnvironmentVariables["DEVWEBUI_TRAY_SHUTDOWN_TOKEN"] = $token
    return [System.Diagnostics.Process]::Start($psi)
  }
  # Poll for the daemon to come up and return the URL it bound. Falls back to the
  # preferred-port URL if it never reports (so Open still does something).
  function Wait-ForUrl($infoFile, $port, $timeoutMs) {
    $elapsed = 0
    while ($elapsed -lt $timeoutMs) {
      $u = Get-RunningUrl $infoFile $port
      if ($u) { return $u }
      Start-Sleep -Milliseconds 250; $elapsed += 250
    }
    return "http://localhost:$port"
  }
}
. $DevControl   # make the functions available on the UI thread

function Test-DevWebUIIconHasSmallFrame($icoPath) {
  try {
    $icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
    if ($icoBytes.Length -le 6 -or $icoBytes[0] -ne 0 -or $icoBytes[1] -ne 0 -or $icoBytes[2] -ne 1 -or $icoBytes[3] -ne 0) { return $false }
    $frameCount = [BitConverter]::ToUInt16($icoBytes, 4)
    for ($fi = 0; $fi -lt $frameCount; $fi++) {
      $fw = $icoBytes[6 + $fi*16]
      if ($fw -ne 0 -and $fw -le 48) { return $true }
    }
  } catch {}
  return $false
}

function New-DevWebUITrayIcon {
  $iconPath = Join-Path $scriptDir "DevWebUI.ico"
  if (-not (Test-Path $iconPath)) { throw "Tray icon file is missing: $iconPath" }
  if (-not (Test-DevWebUIIconHasSmallFrame $iconPath)) { throw "Tray icon has no small frame for the Windows notification area." }

  $icon = New-Object System.Drawing.Icon($iconPath, [System.Windows.Forms.SystemInformation]::SmallIconSize)
  $null = $icon.ToBitmap()
  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.Text = "DevWebUI"
  $ni.Icon = $icon
  return $ni
}

# The shortcut is only considered started once the notification-area icon exists.
# If that fails, do not open the browser or launch a headless daemon.
try {
  $tray = New-DevWebUITrayIcon
  $tray.Visible = $true
} catch {
  if ($tray) { try { $tray.Visible = $false; $tray.Dispose() } catch {} }
  [System.Windows.Forms.MessageBox]::Show("DevWebUI could not start because the tray icon could not be created.`n`n$($_.Exception.Message)", "DevWebUI") | Out-Null
  return
}

# Already running? Attach this tray to the live UI — don't spin up a second daemon.
$existing = Get-RunningUrl $infoFile $port
if ($existing) {
  $script:url = $existing
} else {
  # Bun must be on PATH.
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    [System.Windows.Forms.MessageBox]::Show("Bun was not found on PATH.`nInstall it from https://bun.sh then click DevWebUI again.", "DevWebUI") | Out-Null
    $tray.Visible = $false
    $tray.Dispose()
    return
  }
  # First-run setup ONLY: install deps and build the GUI if there's no build yet. After
  # that the shortcut launches instantly with the existing build — use the tray's
  # "Rebuild & Restart" to pick up source changes.
  if (-not (Test-Path "node_modules")) { & cmd.exe /c "bun install" | Out-Null }
  if (-not (Test-Path "web\dist")) { & cmd.exe /c "bun run build" | Out-Null }
  $startProc = Start-DevWebUI $root $port $script:shutdownToken
  if ($startProc) { $script:shared.serverPid = $startProc.Id }
  $script:url = Wait-ForUrl $infoFile $port 12000
  $script:startedByUs = $true
}

# --- Background worker ------------------------------------------------------------
# Rebuild (optional) + stop + start + wait, off the UI thread. Self-contained: it
# re-defines the daemon-control helpers from the passed-in text.
$worker = {
  param($appRoot, $appScriptDir, $infoFile, $appPort, $token, $doRebuild, $helpersText, $shared, $isDevTree)
  $ErrorActionPreference = 'SilentlyContinue'
  . ([scriptblock]::Create($helpersText))
  $result = [pscustomobject]@{ Ok = $true; Ready = $false; Url = $null }

  # Defense-in-depth: even if a rebuild was somehow requested, refuse it outside a dev
  # tree (see $script:isDevTree above) rather than trying to `bun run build` against a
  # distribution that has no server\src / bun to build with.
  if ($doRebuild -and -not $isDevTree) { $result.Ok = $false; return $result }

  if ($doRebuild) {
    $logPath = Join-Path $appScriptDir "DevWebUI-Rebuild.log"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c cd /d `"$appRoot`" && bun run build > `"$logPath`" 2>&1"
    $psi.WorkingDirectory = $appRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = "Hidden"
    $p = [System.Diagnostics.Process]::Start($psi)
    $shared.buildPid = $p.Id
    # Poll HasExited (interruptible) instead of WaitForExit so a Quit can cancel
    # promptly and reap the build tree instead of the UI blocking on it.
    while (-not $p.HasExited) {
      if ($shared.cancel) { try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch {}; $result.Ok = $false; return $result }
      Start-Sleep -Milliseconds 200
    }
    $shared.buildPid = 0
    if ($p.ExitCode -ne 0) { $result.Ok = $false; return $result }
  }
  if ($shared.cancel) { return $result }

  Stop-DevWebUI $infoFile $appPort $token $true
  Start-Sleep -Milliseconds 300
  $proc = Start-DevWebUI $appRoot $appPort $token
  if ($proc) { $shared.serverPid = $proc.Id }   # so Quit can reap it even before it binds
  Wait-ForUrl $infoFile $appPort 12000 | Out-Null
  $live = Get-RunningUrl $infoFile $appPort
  $result.Url = if ($live) { $live } else { "http://localhost:$appPort" }
  $result.Ready = [bool]$live
  return $result
}

$script:busy = $false
$script:ps = $null
$script:psAsync = $null
$script:jobKind = ''

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open DevWebUI")
# --- DEV-ONLY: gated by $script:isDevTree, set above ------------------------------
# "Rebuild & Restart" rebuilds the GUI from SOURCE — a developer convenience so UI
# edits show up without a manual build. Public/end users get a prebuilt web\dist and
# no `server\src` tree (or necessarily bun) to build with, so this menu item — and the
# worker's rebuild branch below — only run when $script:isDevTree is true (a source
# checkout, or DEVWEBUI_DEV=1 explicitly set). A distributed build never shows it;
# end users do their own rebuilds with the standalone misc\Rebuild.bat instead.
$rebuildItem = New-Object System.Windows.Forms.ToolStripMenuItem("Rebuild & Restart")
# ----------------------------------------------------------------------------------
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart")
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Quit")

# Ticks on the UI thread — polls the worker and, once it finishes, reports the
# outcome, updates the live URL, and re-enables the menu. Only place worker results
# touch the UI, so there's no cross-thread control access.
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 350
$pollTimer.Add_Tick({
  if (-not $script:ps -or -not $script:psAsync) { $pollTimer.Stop(); return }
  if (-not $script:psAsync.IsCompleted) { return }
  $pollTimer.Stop()
  $out = $null
  try {
    $res = $script:ps.EndInvoke($script:psAsync)
    if ($res -and $res.Count -gt 0) { $out = $res[$res.Count - 1] }
  } catch {}
  try { $script:ps.Dispose() } catch {}
  $script:ps = $null; $script:psAsync = $null

  if ($out -and -not $out.Ok) {
    $tray.ShowBalloonTip(3500, "DevWebUI", "GUI build failed. See misc\DevWebUI-Rebuild.log.", [System.Windows.Forms.ToolTipIcon]::Error)
  } elseif ($out -and $out.Ready) {
    if ($out.Url) { $script:url = $out.Url }
    $script:startedByUs = $true
    if ($script:jobKind -eq 'rebuild') { Start-Process $script:url }
  } else {
    $tray.ShowBalloonTip(3500, "DevWebUI", "Restarted, but DevWebUI isn't answering yet.", [System.Windows.Forms.ToolTipIcon]::Warning)
  }
  $rebuildItem.Enabled = $true
  $restartItem.Enabled = $true
  $script:busy = $false
})

function Start-Job-Async([bool]$doRebuild) {
  if ($script:busy) { return }
  # Defense-in-depth: the menu item itself is never added outside a dev tree (see
  # $script:isDevTree above), but refuse a rebuild request here too rather than trust
  # only the menu's absence.
  if ($doRebuild -and -not $script:isDevTree) { return }
  $script:busy = $true
  $script:jobKind = if ($doRebuild) { 'rebuild' } else { 'restart' }
  $rebuildItem.Enabled = $false
  $restartItem.Enabled = $false

  try {
    $script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })
    $script:ps = [System.Management.Automation.PowerShell]::Create()
    [void]$script:ps.AddScript($worker.ToString())
    [void]$script:ps.AddArgument($root)
    [void]$script:ps.AddArgument($scriptDir)
    [void]$script:ps.AddArgument($infoFile)
    [void]$script:ps.AddArgument($port)
    [void]$script:ps.AddArgument($script:shutdownToken)
    [void]$script:ps.AddArgument($doRebuild)
    [void]$script:ps.AddArgument($DevControl.ToString())
    [void]$script:ps.AddArgument($script:shared)
    [void]$script:ps.AddArgument($script:isDevTree)
    $script:psAsync = $script:ps.BeginInvoke()
    $pollTimer.Start()
  } catch {
    # Kicking off the runspace failed — never leave the menu stuck disabled.
    if ($script:ps) { try { $script:ps.Dispose() } catch {} }
    $script:ps = $null; $script:psAsync = $null
    $rebuildItem.Enabled = $true
    $restartItem.Enabled = $true
    $script:busy = $false
    $tray.ShowBalloonTip(3500, "DevWebUI", "Couldn't start the background worker. Try again.", [System.Windows.Forms.ToolTipIcon]::Error)
  }
}

$openItem.Add_Click({ Start-Process $script:url })
$rebuildItem.Add_Click({ Start-Job-Async $true })
$restartItem.Add_Click({ Start-Job-Async $false })
$quitItem.Add_Click({
  $script:shared.cancel = $true
  $pollTimer.Stop()
  # Best-effort graceful shutdown of our own daemon, bounded (3s) so Quit can't hang.
  if ($script:startedByUs) { try { Invoke-DaemonShutdown $script:url $script:shutdownToken 3 | Out-Null } catch {} }
  # If a job is in flight, reap what the worker spawned (build + a daemon that may not
  # have bound yet) so nothing is orphaned and $script:ps.Stop() doesn't block on the
  # build's WaitForExit. When idle the tracked PIDs are stale — the graceful call + port
  # sweep below stop the live daemon — so skip, to never taskkill a reused PID.
  if ($script:busy) {
    foreach ($k in @('buildPid', 'serverPid')) {
      $procId = $script:shared[$k]
      if ($procId -and $procId -gt 0) { try { & taskkill /PID $procId /T /F 2>$null | Out-Null } catch {} }
    }
  }
  if ($script:startedByUs) {
    $sweep = @($port); $bp = Get-PortFromUrl $script:url; if ($bp -gt 0) { $sweep += $bp }
    foreach ($sp in ($sweep | Select-Object -Unique)) {
      foreach ($procId in (Get-PortPids $sp)) { if ($procId -gt 0) { try { & taskkill /PID $procId /T /F 2>$null | Out-Null } catch {} } }
    }
  }
  if ($script:ps) { try { $script:ps.Stop(); $script:ps.Dispose() } catch {} }
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($openItem) | Out-Null
# Only shown in a dev tree (see $script:isDevTree above) — a distributed build never
# gets this menu item at all, not merely a disabled one.
if ($script:isDevTree) { $menu.Items.Add($rebuildItem) | Out-Null }
$menu.Items.Add($restartItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($quitItem) | Out-Null
$tray.ContextMenuStrip = $menu
$tray.Add_MouseDoubleClick({ Start-Process $script:url })

$tray.ShowBalloonTip(2500, "DevWebUI", "Running in the tray - right-click for options.", [System.Windows.Forms.ToolTipIcon]::Info)
Start-Process $script:url

# Run the WinForms message loop (keeps the tray alive until Quit).
[System.Windows.Forms.Application]::Run()

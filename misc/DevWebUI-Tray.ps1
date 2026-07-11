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
# Where the daemon self-logs (see server/src/log-file.ts) — surfaced in the crash balloons so
# the user knows where to look when the watchdog reports a restart.
$logPath = Join-Path $env:USERPROFILE ".devwebui\logs\daemon.log"
# "Full shutdown" sentinel the daemon drops when a user picks Shut Down in the web UI (or runs
# `devwebui stop`): a request to terminate the WHOLE app, this tray included. The watch timer
# below polls for it and runs Quit. Clear any stale one now so a leftover from a hard-killed
# previous run can't make us quit the instant we launch.
$script:shutdownRequestFile = Join-Path (Split-Path -Parent $infoFile) "shutdown.request"
Remove-Item $script:shutdownRequestFile -Force -ErrorAction SilentlyContinue
# Current live URL — updated whenever we (re)start the daemon. Script-scoped so the
# tray menu handlers always open wherever the daemon actually is now.
$script:url = "http://localhost:$port"
$script:shutdownToken = [System.Guid]::NewGuid().ToString("N")
# Tracks whether this tray launched the daemon itself; attached daemons are left alone
# when the tray exits.
$script:startedByUs = $false
# Guards Invoke-QuitApp against double entry (the Quit menu item and the watch timer can
# both fire the full teardown).
$script:quitting = $false
# Shared with the worker runspace (same process heap): the worker records the PIDs it
# spawns so Quit can reap them, and Quit sets `cancel` to stop the worker early.
$script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })
# --- Auto-restart watchdog state --------------------------------------------------
# Nothing else brings a crashed daemon back on its own (see server/src/log-file.ts's crash
# handlers in server/src/index.ts, added alongside this watchdog). This host is the natural
# supervisor: a timer probes /api/health and relaunches a daemon that died unexpectedly. Guards
# keep it from fighting deliberate stops or a daemon this tray doesn't own:
#   · $intentionalStop  — set during Quit so we never resurrect a daemon we're closing.
#   · $script:busy       — a Rebuild/Restart worker owns the daemon; the watchdog stands down.
#   · $script:startedByUs — only revive a daemon THIS tray launched; an attached daemon started
#                            by another session/tray is left alone, same as Stop-DevWebUI's rule.
#   · reviveGraceUntil   — after firing a relaunch, wait for it to bind before trying again (a
#                          fresh daemon takes a few seconds), so we don't spawn a pile-up.
#   · crash-loop guard   — >= MAX restarts within WINDOW seconds ⇒ pause auto-restart and tell
#                          the user (a persistently-broken build must not spin forever).
$script:intentionalStop = $false
$script:autoRestartPaused = $false
$script:reviveGraceUntil = [DateTime]::MinValue
$script:restartTimes = New-Object System.Collections.Generic.List[DateTime]
$CrashLoopMax = 4          # restarts…
$CrashLoopWindowSec = 120  # …within this many seconds ⇒ pause

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

# --- Portable mode: open the app UI in a chromeless Chromium app window instead of a
# normal browser tab, when the daemon's runtime.json says the setting is on. Mirrors the
# shared kit's server/src/portable-window.mjs resolve-and-fallback chain in PowerShell,
# for cold starts (before the daemon — and therefore that lib — is running).
function Resolve-ChromiumBrowser {
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe") }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe") }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe") }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe") }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

# Open the app UI at $url: a portable app window when the setting is on and a Chromium
# browser is available, else a normal browser tab. Re-reads runtime.json fresh each call
# so a mid-session toggle (Settings → Portable window) takes effect on the NEXT open.
function Open-AppUi([string]$url) {
  $portable = $false
  try {
    if (Test-Path $infoFile) {
      $info = Get-Content $infoFile -Raw | ConvertFrom-Json
      $portable = [bool]$info.portableMode
    }
  } catch { $portable = $false }
  if ($portable) {
    $browser = Resolve-ChromiumBrowser
    if ($browser) {
      # Dedicated profile so Chromium remembers the app window's size/position across
      # launches instead of sharing (and fighting over) the user's main browser profile.
      # Family convention: <configDir>/portable-profile, a sibling of runtime.json — same
      # path the daemon's POST /api/portable-window derives, so both open paths share one
      # profile. If it can't be created, spawn without the profile args (window still
      # opens; geometry just isn't remembered) rather than falling back to a plain tab.
      $profileDir = Join-Path (Split-Path -Parent $infoFile) "portable-profile"
      $profileReady = $true
      try {
        if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
      } catch { $profileReady = $false }
      if ($profileReady) {
        Start-Process $browser -ArgumentList @("--user-data-dir=`"$profileDir`"", "--no-first-run", "--no-default-browser-check", "--app=$url")
      } else {
        Start-Process $browser -ArgumentList "--app=$url"
      }
      return
    }
  }
  Start-Process $url
}

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
    if ($script:jobKind -eq 'rebuild') { Open-AppUi $script:url }
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
  # An explicit Restart/Rebuild is the user re-arming things: clear any crash-loop pause and
  # the restart history so the watchdog resumes cleanly once the worker hands the daemon back.
  $script:autoRestartPaused = $false
  $script:restartTimes.Clear()
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

$openItem.Add_Click({ Open-AppUi $script:url })
$rebuildItem.Add_Click({ Start-Job-Async $true })
$restartItem.Add_Click({ Start-Job-Async $false })
# The full teardown: stop the worker, gracefully shut down our daemon, reap anything it
# spawned, sweep the port, remove the notification-area icon, and exit the message loop.
# Called by BOTH the Quit menu item AND the watch timer that fires when a user picks
# "Shut Down" in the web UI (which drops the shutdown.request sentinel) — so both paths
# terminate the WHOLE app, not just the daemon.
function Invoke-QuitApp {
  if ($script:quitting) { return }   # re-entrancy guard (menu + watch timer could both fire)
  $script:quitting = $true
  # Tell the watchdog we're closing on purpose BEFORE we touch the daemon, so it doesn't
  # relaunch what we're about to stop.
  $script:intentionalStop = $true
  if ($healthTimer) { try { $healthTimer.Stop() } catch {} }
  Remove-Item $script:shutdownRequestFile -Force -ErrorAction SilentlyContinue
  if ($watchTimer) { try { $watchTimer.Stop() } catch {} }
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
}
$quitItem.Add_Click({ Invoke-QuitApp })
$menu.Items.Add($openItem) | Out-Null
# Only shown in a dev tree (see $script:isDevTree above) — a distributed build never
# gets this menu item at all, not merely a disabled one.
if ($script:isDevTree) { $menu.Items.Add($rebuildItem) | Out-Null }
$menu.Items.Add($restartItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($quitItem) | Out-Null
$tray.ContextMenuStrip = $menu
$tray.Add_MouseDoubleClick({ Open-AppUi $script:url })

# Watch for a "Shut Down" issued from the web UI (or `devwebui stop`): the daemon drops the
# shutdown.request sentinel and we tear the whole app down — otherwise the daemon would exit
# but this tray (and its notification-area icon) would linger. The tray's own Restart/Rebuild
# carry the session token so they never write the sentinel, and auto-update relaunches don't
# either; a Rebuild/Restart mid-flight ($script:busy) is skipped so its internal stop isn't
# mistaken for a quit.
$watchTimer = New-Object System.Windows.Forms.Timer
$watchTimer.Interval = 500
$watchTimer.Add_Tick({
  if ($script:busy) { return }
  if (Test-Path $script:shutdownRequestFile) { Invoke-QuitApp }
})
$watchTimer.Start()

# --- Auto-restart watchdog --------------------------------------------------------
# Ticks on the UI thread; each tick is cheap (one /api/health probe via Get-RunningUrl) and
# NEVER blocks — a relaunch is fire-and-forget (Start-DevWebUI returns as soon as it spawns),
# and recovery is observed on a later tick, so the tray stays responsive even while the daemon
# reboots.
$healthTimer = New-Object System.Windows.Forms.Timer
$healthTimer.Interval = 5000
$healthTimer.Add_Tick({
  # Deliberate close, a Rebuild/Restart worker owns the daemon, or this tray never launched
  # the daemon (an attached instance owned elsewhere) → stand down.
  if ($script:intentionalStop -or $script:busy -or -not $script:startedByUs) { return }

  $u = Get-RunningUrl $infoFile $port
  if ($u) { $script:url = $u; return }         # healthy (track where it actually bound)

  # Down. Wait out the grace window after a relaunch so a still-booting daemon isn't
  # double-spawned, and honour a crash-loop pause.
  if ((Get-Date) -lt $script:reviveGraceUntil) { return }
  if ($script:autoRestartPaused) { return }

  # Crash-loop guard: prune attempts outside the window, then bail if we've hit the cap.
  $cutoff = (Get-Date).AddSeconds(-$CrashLoopWindowSec)
  for ($i = $script:restartTimes.Count - 1; $i -ge 0; $i--) {
    if ($script:restartTimes[$i] -lt $cutoff) { $script:restartTimes.RemoveAt($i) }
  }
  if ($script:restartTimes.Count -ge $CrashLoopMax) {
    $script:autoRestartPaused = $true
    $tray.ShowBalloonTip(6000, "DevWebUI", "DevWebUI keeps crashing - auto-restart paused. See $logPath, then use Restart to try again.", [System.Windows.Forms.ToolTipIcon]::Error)
    return
  }

  # Relaunch (same path the tray uses everywhere else — cmd->bun so taskkill /T can reap it).
  $script:restartTimes.Add((Get-Date))
  $script:reviveGraceUntil = (Get-Date).AddSeconds(20)
  $relaunched = Start-DevWebUI $root $port $script:shutdownToken
  if ($relaunched) { $script:shared.serverPid = $relaunched.Id }
  $tray.ShowBalloonTip(4000, "DevWebUI", "DevWebUI stopped unexpectedly - restarting. Log: $logPath", [System.Windows.Forms.ToolTipIcon]::Warning)
})
$healthTimer.Start()

$tray.ShowBalloonTip(2500, "DevWebUI", "Running in the tray - right-click for options.", [System.Windows.Forms.ToolTipIcon]::Info)
Open-AppUi $script:url

# Run the WinForms message loop (keeps the tray alive until Quit).
[System.Windows.Forms.Application]::Run()

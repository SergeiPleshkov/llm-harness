# llmctl: control the local llama-server (Windows desktop only).
# Config: server.json next to this script (C:\llm by default). The API key is read from a file by llama-server,
# never passed on the command line.
#   llmctl.ps1 up     start the server and open it to the laptop over Tailscale (desktop shortcut "LLM - start")
#   llmctl.ps1 down   stop the server and unload Ollama models to free the GPU (desktop shortcut "LLM - stop (free GPU)")
#   llmctl.ps1 start [-Mtp] [-LoopbackOnly] | run | stop | restart | status | logs [-Follow]
#   -Pause keeps the window open at the end (used by the shortcuts).
param(
  [Parameter(Position = 0)][ValidateSet('up', 'down', 'start', 'run', 'stop', 'restart', 'status', 'logs')][string]$Action = 'status',
  [switch]$Mtp,
  [switch]$LoopbackOnly,
  [switch]$Follow,
  [switch]$Pause
)
$ErrorActionPreference = 'Stop'
# llmctl is deployed next to its server.json (by install-shortcuts.ps1).
$Root         = $PSScriptRoot
$cfg          = Get-Content (Join-Path $Root 'server.json') -Raw | ConvertFrom-Json
$PidFile      = Join-Path $Root 'run\server.pid'
$LogDir       = Join-Path $Root 'logs'
$ErrLog       = Join-Path $LogDir 'server.err.log'
$OutLog       = Join-Path $LogDir 'server.out.log'
$Tailscale    = 'C:\Program Files\Tailscale\tailscale.exe'
$FirewallRule = 'llm-server (Tailscale only)'
$TaskName     = 'llm-server'

function Get-ServerProc {
  if (-not (Test-Path $PidFile)) { return $null }
  $id = [int]((Get-Content $PidFile -Raw).Trim())
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'llama-server') { return $p }
  return $null
}

function Get-ServerHosts([Diagnostics.Process]$p) {
  $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").CommandLine
  if ($cl -match '--host\s+(\S+)') { return $Matches[1] }
  return ''
}

function Get-TailscaleIp([int]$Tries = 12) {
  # At logon Tailscale may not be up yet: by default retry for up to 60 s.
  for ($i = 0; $i -lt $Tries; $i++) {
    if (Test-Path $Tailscale) {
      try {
        $ip = (& $Tailscale ip -4 2>$null | Select-Object -First 1)
        if ($ip -match '^100\.') { return $ip }
      } catch {}
    }
    if ($i -lt $Tries - 1) { Start-Sleep -Seconds 5 }
  }
  return $null
}

function Get-TailscaleState {
  try { return ((& $Tailscale status --json 2>$null | Out-String) | ConvertFrom-Json).BackendState } catch { return 'Unknown' }
}

function Confirm-Tailscale {
  # Returns a problem description, or $null when Tailscale is connected.
  if (-not (Test-Path $Tailscale)) { return 'Tailscale is not installed: the laptop cannot connect' }
  $state = Get-TailscaleState
  if ($state -eq 'Stopped') {
    Write-Host 'Tailscale is off, starting it...'
    try { & $Tailscale up 2>$null | Out-Null } catch {}
    Start-Sleep -Seconds 3
    $state = Get-TailscaleState
  }
  if ($state -ne 'Running') { return "Tailscale is in state '$state': log in to Tailscale, otherwise the laptop cannot connect" }
  return $null
}

function Get-FirewallIssues {
  $issues = @()
  try {
    # Any enabled inbound allow rule named llm-server* counts (port-only or program-bound variant).
    $mine = Get-NetFirewallRule -DisplayName 'llm-server*' -ErrorAction SilentlyContinue |
            Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }
    if (-not $mine) { $issues += "no firewall rule '$FirewallRule': the laptop cannot connect" }
    $blocks = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*\llama-server.exe' } | Get-NetFirewallRule |
              Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }
    foreach ($b in $blocks) { $issues += "blocking rule '$($b.DisplayName)' for llama-server.exe blocks access: remove it" }
  } catch { $issues += 'could not check the firewall' }
  return $issues
}

function Test-Health {
  try { return (Invoke-WebRequest -Uri "http://127.0.0.1:$($cfg.port)/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}

function Show-Vram {
  $v = (& nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits) -split ','
  $used = [int]$v[0].Trim(); $total = [int]$v[1].Trim()
  Write-Host ("VRAM: {0:N1} of {1:N1} GiB used, {2:N1} GiB free" -f ($used / 1024), ($total / 1024), (($total - $used) / 1024))
}

function Write-McpConfig {
  # llama-server spawns these MCP servers itself (stdio); the web UI shows their tools as web_search / web_fetch.
  foreach ($f in $cfg.mcp.node, $cfg.mcp.web) { if (-not (Test-Path $f)) { throw "missing file: $f" } }
  $path = Join-Path $Root 'run\mcp.json'
  $web = @{ command = $cfg.mcp.node; args = @($cfg.mcp.web); timeout_ms = [int]$cfg.mcp.timeoutMs
            env = @{ WEB_MCP_LOG = (Join-Path $LogDir 'web-mcp.jsonl') } }
  [IO.File]::WriteAllText($path, (@{ mcpServers = @{ web = $web } } | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  return $path
}

function Start-Server {
  # Returns $true once the server answers /health.
  if (Get-ServerProc) { Write-Host 'server is already running'; return $true }
  foreach ($f in $cfg.bin, $cfg.model, $cfg.mmproj, $cfg.apiKeyFile) { if (-not (Test-Path $f)) { throw "missing file: $f" } }
  New-Item -ItemType Directory -Force (Split-Path $PidFile), $LogDir | Out-Null
  foreach ($l in $ErrLog, $OutLog) { if (Test-Path $l) { Move-Item $l "$l.prev" -Force } }

  $hosts = @('127.0.0.1')
  if (-not $LoopbackOnly) {
    $ts = Get-TailscaleIp
    if ($ts) { $hosts += $ts } else { Write-Warning 'no Tailscale address: the server will only be reachable from this PC' }
  }
  $srvArgs = @(
    '-m', $cfg.model, '--mmproj', $cfg.mmproj, '--alias', $cfg.alias,
    '--host', ($hosts -join ','), '--port', [string]$cfg.port,
    '-c', [string]$cfg.ctx, '-np', [string]$cfg.slots, '-kvu',
    '-ngl', 'all', '-fa', 'on', '-ctk', $cfg.kvType, '-ctv', $cfg.kvType,
    '--jinja', '--api-key-file', $cfg.apiKeyFile, '--metrics'
  )
  if ($cfg.mmprojOffload -eq $false) { $srvArgs += '--no-mmproj-offload' }
  if ($Mtp -or $cfg.mtp.enabled) {
    $srvArgs += @('--spec-type', 'draft-mtp', '--spec-draft-model', $cfg.mtp.model, '--spec-draft-n-max', [string]$cfg.mtp.nMax)
  }
  if ($cfg.mcp.enabled) {
    # MCP also switches the CORS default to localhost. The web UI is same-origin (also from the laptop), so it is unaffected.
    $srvArgs += @('--mcp-servers-config', (Write-McpConfig))
  }
  $p = Start-Process -FilePath $cfg.bin -ArgumentList $srvArgs -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WorkingDirectory (Split-Path $cfg.bin)
  Set-Content -Path $PidFile -Value $p.Id -Encoding ASCII
  Write-Host ("started pid {0} on {1}:{2}, loading model..." -f $p.Id, ($hosts -join ','), $cfg.port)

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ready = $false
  while ($sw.Elapsed.TotalSeconds -lt 300) {
    if ($p.HasExited) {
      Write-Host "llama-server exited with code $($p.ExitCode). Last log lines:" -ForegroundColor Red
      Get-Content $ErrLog -Tail 30 | Out-Host
      Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
      return $false
    }
    if (Test-Health) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { Write-Warning 'the server did not respond within 300 s, see: llmctl.ps1 logs'; return $false }
  Write-Host ("ready in {0:N0} s" -f $sw.Elapsed.TotalSeconds)
  # 'run' is what Task Scheduler launches: stay alive as long as the server does, so the task owns its lifetime.
  if ($Action -eq 'run') {
    $p.WaitForExit()
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit $p.ExitCode
  }
  return $true
}

function Stop-Server {
  $p = Get-ServerProc
  if (-not $p) { Write-Host 'server is not running'; Remove-Item $PidFile -Force -ErrorAction SilentlyContinue; return }
  Stop-Process -Id $p.Id -Force
  $p.WaitForExit(15000) | Out-Null
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'server stopped'
}

function Show-Status {
  $p = Get-ServerProc
  if (-not $p) { Write-Host 'server stopped'; Show-Vram; return }
  Write-Host ("running pid {0}, {1:N0} min, health: {2}, listening: {3}" -f $p.Id, ((Get-Date) - $p.StartTime).TotalMinutes, $(if (Test-Health) { 'ok' } else { 'not ready' }), (Get-ServerHosts $p))
  try {
    $key = (Get-Content $cfg.apiKeyFile -TotalCount 1).Trim()
    $m = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/v1/models" -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 5
    Write-Host ('models: ' + (($m.data | ForEach-Object { $_.id }) -join ', '))
  } catch { Write-Host "models: request failed ($($_.Exception.Message))" }
  Show-Vram
}

function Invoke-Up {
  $warn = @()
  if (-not $LoopbackOnly) { $t = Confirm-Tailscale; if ($t) { $warn += $t } }
  $p = Get-ServerProc
  if ($p -and -not $LoopbackOnly) {
    $ip = Get-TailscaleIp 1
    if ($ip -and ((Get-ServerHosts $p) -notlike "*$ip*")) { Write-Host 'the server listens on localhost only: restarting with Tailscale access'; Stop-Server }
  }
  if (-not (Start-Server)) { return 1 }
  if (-not $LoopbackOnly) { $warn += @(Get-FirewallIssues) }
  $ip = Get-TailscaleIp 1
  Write-Host ''
  Write-Host ("Model {0} is ready." -f $cfg.alias) -ForegroundColor Green
  Write-Host ("  from this PC:  http://127.0.0.1:{0}/v1" -f $cfg.port)
  if ($ip -and -not $LoopbackOnly) { Write-Host ("  from the laptop:  http://{0}:{1}/v1" -f $ip, $cfg.port) }
  if ($cfg.mcp.enabled) { Write-Host '  the web chat can search the internet: web_search, web_fetch' }
  Show-Vram
  foreach ($w in $warn) { Write-Warning $w }
  if ($warn.Count -gt 0) { return 2 }
  return 0
}

function Invoke-Down {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName; Write-Host 'autostart task stopped' }
  Stop-Server
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    try {
      $names = & ollama ps 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_.Trim() -split '\s+')[0] } | Where-Object { $_ }
      foreach ($n in $names) { & ollama stop $n 2>$null | Out-Null; Write-Host "Ollama: unloaded model $n" }
    } catch {}
  }
  Start-Sleep -Seconds 2
  Show-Vram
  Write-Host 'GPU is free.' -ForegroundColor Green
  return 0
}

$code = 0
try {
  switch ($Action) {
    'up'      { $code = Invoke-Up }
    'down'    { $code = Invoke-Down }
    'start'   { if (-not (Start-Server)) { $code = 1 } }
    'run'     { if (-not (Start-Server)) { $code = 1 } }
    'stop'    { Stop-Server }
    'restart' { Stop-Server; if (-not (Start-Server)) { $code = 1 } }
    'status'  { Show-Status }
    'logs'    { if ($Follow) { Get-Content $ErrLog -Tail 40 -Wait } else { Get-Content $ErrLog -Tail 60 } }
  }
} catch {
  Write-Host ('Error: ' + $_.Exception.Message) -ForegroundColor Red
  $code = 1
}
if ($Pause) {
  Write-Host ''
  if ($code -eq 0) { Write-Host 'The window will close in 8 seconds.'; Start-Sleep -Seconds 8 }
  else { Read-Host 'Press Enter to close this window' | Out-Null }
}
exit $code

# Read-only discovery of local LLM setup + Claude Code harness (Windows).
# Installs nothing, changes nothing. Secrets are redacted.
# Run:  powershell -ExecutionPolicy Bypass -File .\tools\llm-discovery.ps1
# Report is written to llm-report.txt next to this script and printed to the console.

$ErrorActionPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'
$out = New-Object System.Collections.Generic.List[string]
function W([string]$s) { $out.Add($s) }
function Sec([string]$s) { W ''; W "===== $s =====" }
function Redact([string]$s) {
  if (-not $s) { return $s }
  $s = [regex]::Replace($s, '(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+', '$1***REDACTED***')
  $s = [regex]::Replace($s, '(?i)("?(api[_-]?key|token|secret|password|authorization)"?\s*[:=]\s*"?)[^",\s]+', '$1***REDACTED***')
  return $s
}
function Has([string]$n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Run([scriptblock]$b) { try { (& $b 2>&1 | Out-String).TrimEnd() } catch { "error: $_" } }

Sec 'SYSTEM'
$os = Get-CimInstance Win32_OperatingSystem
W "OS: $($os.Caption) $($os.Version) build $($os.BuildNumber)"
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
W "CPU: $($cpu.Name)  cores=$($cpu.NumberOfCores) threads=$($cpu.NumberOfLogicalProcessors)"
$cs = Get-CimInstance Win32_ComputerSystem
W ("RAM: {0:N1} GB" -f ($cs.TotalPhysicalMemory / 1GB))
W "Host: $env:COMPUTERNAME  User: $env:USERNAME  PS: $($PSVersionTable.PSVersion)"
Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  if ($_.Used -ne $null) { W ("Drive {0}: free {1:N0} GB / total {2:N0} GB" -f $_.Name, ($_.Free/1GB), (($_.Used+$_.Free)/1GB)) }
}

Sec 'GPU'
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi -and (Test-Path "$env:SystemRoot\System32\nvidia-smi.exe")) { $smi = "$env:SystemRoot\System32\nvidia-smi.exe" }
if ($smi) {
  W (Run { & nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version,power.limit --format=csv })
  W (Run { & nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv })
  W (Run { & nvidia-smi | Select-String 'CUDA Version' })
} else { W 'nvidia-smi not found' }
Get-CimInstance Win32_VideoController | ForEach-Object { W "Adapter: $($_.Name)  driver $($_.DriverVersion)" }

Sec 'TOOLS'
$tools = 'ollama','llama-server','llama-cli','lms','vllm','litellm','open-webui','qwen','opencode','aider','claude','tailscale','docker','wsl','node','npm','python','py','uv','jq','git','bash','winget','nssm'
foreach ($t in $tools) {
  $c = Get-Command $t -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) {
    $v = ''
    if ($t -notin @('wsl','bash','winget')) { $v = (Run { & $t --version } | Select-Object -First 1) -split "`n" | Select-Object -First 1 }
    W ("{0,-14} {1}  ({2})" -f $t, $v, $c.Source)
  } else { W ("{0,-14} -" -f $t) }
}
if (Has 'ollama') { W '--- ollama list'; W (Run { ollama list }); W '--- ollama ps'; W (Run { ollama ps }) }
if (Has 'lms') { W '--- lms ls'; W (Run { lms ls }); W '--- lms ps'; W (Run { lms ps }) }
if (Has 'docker') { W '--- docker'; W (Run { docker ps -a --format '{{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}' }) }
if (Has 'wsl') { W '--- wsl -l -v'; W (Run { wsl -l -v }) }
W '--- LM Studio / Ollama installs'
foreach ($p in @("$env:LOCALAPPDATA\Programs\LM Studio","$env:LOCALAPPDATA\Programs\Ollama","$env:ProgramFiles\LM Studio","$env:USERPROFILE\.lmstudio","$env:USERPROFILE\.ollama")) {
  if (Test-Path $p) { W "present: $p" }
}

Sec 'SERVICES / SCHEDULED TASKS'
Get-Service | Where-Object { $_.Name -match 'ollama|llama|lmstudio|litellm|webui|tailscale' -or $_.DisplayName -match 'ollama|llama|LM Studio|litellm|webui|tailscale' } |
  ForEach-Object { W "service: $($_.Name) [$($_.Status)] $($_.DisplayName)" }
Get-ScheduledTask | Where-Object { $_.TaskName -match 'ollama|llama|lmstudio|litellm|webui' } |
  ForEach-Object { W "task: $($_.TaskName) [$($_.State)]" }
Get-CimInstance Win32_StartupCommand | Where-Object { $_.Command -match 'ollama|llama|LM Studio|lms|litellm' } |
  ForEach-Object { W "startup: $($_.Name) -> $($_.Command)" }

Sec 'LLM PROCESSES'
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'ollama|llama|lms|LM Studio|vllm|litellm' -or $_.CommandLine -match 'llama-server|ollama|vllm|litellm|open-webui' } |
  ForEach-Object { $cl = "$($_.CommandLine)"; if ($cl.Length -gt 400) { $cl = $cl.Substring(0,400) }; W ("pid {0} {1}: {2}" -f $_.ProcessId, $_.Name, (Redact $cl)) }

Sec 'LISTENING LLM ENDPOINTS'
$ports = 11434,8080,8081,1234,8000,8001,30000,4000,3000,5000
$listen = Get-NetTCPConnection -State Listen | Where-Object { $ports -contains $_.LocalPort }
foreach ($l in $listen) {
  $pn = (Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  W ("listen {0}:{1}  pid {2} {3}" -f $l.LocalAddress, $l.LocalPort, $l.OwningProcess, $pn)
}
foreach ($p in $ports) {
  foreach ($path in '/v1/models','/api/tags','/health') {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p$path" -TimeoutSec 2 -UseBasicParsing
      $body = $r.Content; if ($body.Length -gt 600) { $body = $body.Substring(0,600) }
      W "port $p $path -> $body"
    } catch {}
  }
}

Sec 'MODEL FILES'
$dirs = @("$env:USERPROFILE\.ollama\models","$env:USERPROFILE\.lmstudio\models","$env:USERPROFILE\.cache\lm-studio\models","$env:USERPROFILE\.cache\huggingface\hub","$env:USERPROFILE\models")
if ($env:OLLAMA_MODELS) { $dirs += $env:OLLAMA_MODELS }
foreach ($d in $dirs) {
  if (Test-Path $d) {
    $sz = (Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    W ("{0}  {1:N1} GB" -f $d, ($sz/1GB))
  }
}
W '--- *.gguf > 500 MB (user profile + model dirs)'
$roots = @($env:USERPROFILE) + $dirs | Where-Object { Test-Path $_ } | Select-Object -Unique
$seen = @{}
foreach ($r in $roots) {
  Get-ChildItem $r -Recurse -Depth 7 -Filter *.gguf -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 500MB } |
    ForEach-Object { if (-not $seen[$_.FullName]) { $seen[$_.FullName] = 1; W ("{0,7:N1} GB  {1}" -f ($_.Length/1GB), $_.FullName) } }
}
W '--- ollama blobs are listed via "ollama list" above'

Sec 'CLAUDE CODE'
if (Has 'claude') { W (Run { claude --version }) }
$cd = "$env:USERPROFILE\.claude"
foreach ($f in 'settings.json','settings.local.json') {
  W "--- $cd\$f"
  if (Test-Path "$cd\$f") { W (Redact (Get-Content "$cd\$f" -Raw)) }
}
W "--- $cd\CLAUDE.md (head)"
if (Test-Path "$cd\CLAUDE.md") { W ((Get-Content "$cd\CLAUDE.md" -TotalCount 60) -join "`n") }
foreach ($sub in 'agents','skills','commands') { if (Test-Path "$cd\$sub") { W "--- $sub"; W ((Get-ChildItem "$cd\$sub" | Select-Object -ExpandProperty Name) -join ', ') } }
foreach ($f in 'plugins\installed_plugins.json','plugins\known_marketplaces.json') {
  if (Test-Path "$cd\$f") { W "--- $f"; W (Redact ((Get-Content "$cd\$f" -TotalCount 60) -join "`n")) }
}
W '--- MCP servers (names only)'
$cj = "$env:USERPROFILE\.claude.json"
if (Test-Path $cj) {
  try { $j = Get-Content $cj -Raw | ConvertFrom-Json; if ($j.mcpServers) { W (($j.mcpServers.PSObject.Properties | Select-Object -ExpandProperty Name) -join ', ') } } catch { W 'could not parse .claude.json' }
}
W '--- env (names only)'
Get-ChildItem env: | Where-Object { $_.Name -match '^(ANTHROPIC|CLAUDE|OPENAI|OLLAMA|LLAMA|QWEN|LITELLM|CUDA|HF_)' } | ForEach-Object { W "$($_.Name)=<set>" }

Sec 'OTHER AGENT CONFIGS'
foreach ($f in @("$env:USERPROFILE\.qwen\settings.json","$env:USERPROFILE\.config\opencode\opencode.json","$env:USERPROFILE\.aider.conf.yml","$env:USERPROFILE\.continue\config.yaml","$env:USERPROFILE\.continue\config.json","$env:USERPROFILE\.lmstudio\settings.json")) {
  if (Test-Path $f) { W "--- $f"; W (Redact ((Get-Content $f -TotalCount 60) -join "`n")) }
}

Sec 'NETWORK'
if (Has 'tailscale') { W (Run { tailscale status }) } else { W 'tailscale: not installed' }
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { W "ip: $($_.IPAddress) ($($_.InterfaceAlias))" }
Get-NetAdapter -Physical | ForEach-Object { W "nic: $($_.Name) $($_.LinkSpeed) $($_.Status) WoL-capable-check: see adapter power settings" }
W 'done.'

$report = Join-Path $PSScriptRoot 'llm-report.txt'
$out | Set-Content -Path $report -Encoding UTF8
$out | ForEach-Object { Write-Output $_ }
Write-Host ""
Write-Host "Report saved to: $report" -ForegroundColor Green

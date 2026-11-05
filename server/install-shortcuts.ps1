# install-shortcuts.ps1: deploys llmctl + config + the web MCP server to $Root (-Root, default C:\llm)
# and creates two desktop shortcuts with icons:
#   "LLM - start"          -> llmctl.ps1 up -Pause    (start the server, open it to the laptop over Tailscale)
#   "LLM - stop (free GPU)" -> llmctl.ps1 down -Pause  (stop the server, unload Ollama models, free the GPU)
# Safe to re-run: files and shortcuts are overwritten.
param([string]$Root = 'C:\llm')
$ErrorActionPreference = 'Stop'
$src     = $PSScriptRoot
$iconDir = Join-Path $Root 'icons'
New-Item -ItemType Directory -Force $iconDir | Out-Null

# Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page, so deploy llmctl as UTF-8 with BOM.
$utf8Bom = New-Object System.Text.UTF8Encoding $true
[IO.File]::WriteAllText((Join-Path $Root 'llmctl.ps1'), [IO.File]::ReadAllText((Join-Path $src 'llmctl.ps1'), [Text.Encoding]::UTF8), $utf8Bom)
Copy-Item (Join-Path $src 'server.json') (Join-Path $Root 'server.json') -Force
New-Item -ItemType Directory -Force (Join-Path $Root 'mcp') | Out-Null
Copy-Item (Join-Path $src 'mcp\web.mjs') (Join-Path $Root 'mcp\web.mjs') -Force

Add-Type -AssemblyName System.Drawing
function New-Icon([string]$path, [System.Drawing.Color]$bg, [scriptblock]$drawGlyph) {
  $bmp = New-Object System.Drawing.Bitmap 256, 256, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $bg), 8, 8, 240, 240)
  & $drawGlyph $g
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $g.Dispose(); $bmp.Dispose()
  # ICO container holding one 256x256 PNG image (supported since Windows Vista).
  $w = New-Object IO.BinaryWriter ([IO.File]::Create($path))
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)              # ICONDIR: reserved, type=icon, count
  $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0) # 256x256 (0 = 256), no palette, reserved
  $w.Write([UInt16]1); $w.Write([UInt16]32)                                   # planes, bits per pixel
  $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)                         # image size, offset
  $w.Write($png)
  $w.Close()
}
$white = [System.Drawing.Brushes]::White
$startIcon = Join-Path $iconDir 'llm-start.ico'
$stopIcon  = Join-Path $iconDir 'llm-stop.ico'
New-Icon $startIcon ([System.Drawing.Color]::FromArgb(46, 158, 68)) {
  param($g)
  $g.FillPolygon($white, [System.Drawing.Point[]]@(
    (New-Object System.Drawing.Point 100, 70), (New-Object System.Drawing.Point 100, 186), (New-Object System.Drawing.Point 194, 128)))
}
New-Icon $stopIcon ([System.Drawing.Color]::FromArgb(198, 40, 40)) {
  param($g)
  $g.FillRectangle($white, 82, 82, 92, 92)
}

$desktop = [Environment]::GetFolderPath('Desktop')
$ps      = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell   = New-Object -ComObject WScript.Shell
function New-Shortcut([string]$name, [string]$llmArgs, [string]$icon, [string]$desc) {
  $path = Join-Path $desktop "$name.lnk"
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath       = $ps
  $lnk.Arguments        = "-NoProfile -ExecutionPolicy Bypass -File `"$Root\llmctl.ps1`" $llmArgs -Pause"
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation     = "$icon,0"
  $lnk.Description      = $desc
  $lnk.WindowStyle      = 1
  $lnk.Save()
  Write-Host "shortcut: $path"
}
New-Shortcut 'LLM - start'           'up'   $startIcon 'Start the local model and open it to the laptop over Tailscale'
New-Shortcut 'LLM - stop (free GPU)' 'down' $stopIcon  'Stop the local model and free the GPU'

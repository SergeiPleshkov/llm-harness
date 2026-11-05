# bench.ps1: quick sanity + speed check of the local llama-server (decode tok/s, prefill tok/s, tool calling, VRAM).
# Usage: powershell -File bench.ps1 [-BaseUrl http://127.0.0.1:8080] [-KeyFile C:\llm\secrets\api-key.txt] [-Model qwen3.8-27b]
param(
  [string]$BaseUrl = 'http://127.0.0.1:8080',
  [string]$KeyFile = 'C:\llm\secrets\api-key.txt',
  [string]$Model   = 'qwen3.8-27b'
)
$ErrorActionPreference = 'Stop'
$key = (Get-Content $KeyFile -TotalCount 1).Trim()
$headers = @{ Authorization = "Bearer $key" }

function Invoke-Chat([hashtable]$body) {
  $json = $body | ConvertTo-Json -Depth 12 -Compress
  Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" -Method Post -Headers $headers `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 600
}

$noThink = @{ enable_thinking = $false }
$rows = @()

# 1) decode speed
$r = Invoke-Chat @{
  model = $Model; max_tokens = 400; temperature = 0.7; chat_template_kwargs = $noThink
  messages = @(@{ role = 'user'; content = 'Write a Python function that parses ISO-8601 dates without libraries, with a few unit tests.' })
}
$rows += [pscustomobject]@{ test = 'decode'; detail = ("{0} tokens" -f $r.timings.predicted_n); value = ("{0:N1} tok/s" -f $r.timings.predicted_per_second) }

# 2) prefill speed (~8k tokens of filler)
$filler = (1..700 | ForEach-Object { "Record $_ : the service handled request number $($_ * 7) in $($_ % 97) ms without errors." }) -join "`n"
$r = Invoke-Chat @{
  model = $Model; max_tokens = 24; temperature = 0.0; chat_template_kwargs = $noThink; cache_prompt = $false
  messages = @(@{ role = 'user'; content = "$filler`n`nIn one short sentence: what do these records describe?" })
}
$rows += [pscustomobject]@{ test = 'prefill'; detail = ("{0} prompt tokens" -f $r.timings.prompt_n); value = ("{0:N0} tok/s" -f $r.timings.prompt_per_second) }

# 3) tool calling
$r = Invoke-Chat @{
  model = $Model; max_tokens = 256; temperature = 0.0; chat_template_kwargs = $noThink
  messages = @(@{ role = 'user'; content = 'What is the weather in Warsaw right now?' })
  tools = @(@{ type = 'function'; function = @{
      name = 'get_weather'; description = 'Get current weather for a city'
      parameters = @{ type = 'object'; properties = @{ city = @{ type = 'string' } }; required = @('city') } } })
}
$tc = $r.choices[0].message.tool_calls
$ok = $false
if ($tc) { try { $a = $tc[0].function.arguments | ConvertFrom-Json; $ok = ($tc[0].function.name -eq 'get_weather' -and $a.city) } catch {} }
$rows += [pscustomobject]@{ test = 'tool call'; detail = 'get_weather(city)'; value = $(if ($ok) { 'OK' } else { 'FAILED' }) }

# 4) vision: render a small PNG with known text and ask the model to read it
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 420, 120
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.DrawString('HELLO 4271', (New-Object System.Drawing.Font('Arial', 44, [System.Drawing.FontStyle]::Bold)), [System.Drawing.Brushes]::Black, 10, 20)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$b64 = [Convert]::ToBase64String($ms.ToArray())
$g.Dispose(); $bmp.Dispose()
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-Chat @{
  model = $Model; max_tokens = 40; temperature = 0.0; chat_template_kwargs = $noThink
  messages = @(@{ role = 'user'; content = @(
      @{ type = 'image_url'; image_url = @{ url = "data:image/png;base64,$b64" } },
      @{ type = 'text'; text = 'Read the text in the image. Reply with the text only.' }) })
}
$sw.Stop()
$ans = $r.choices[0].message.content
$rows += [pscustomobject]@{ test = 'vision'; detail = ("{0:N1} s, answer: {1}" -f $sw.Elapsed.TotalSeconds, ($ans -replace '\s+', ' ').Trim()); value = $(if ($ans -match '4271') { 'OK' } else { 'FAILED' }) }

$rows | Format-Table -AutoSize | Out-String
'VRAM used/total (MiB): ' + (& nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader)

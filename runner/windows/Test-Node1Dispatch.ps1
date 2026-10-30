<#
.SYNOPSIS
  Node 1 dispatch-to-GPU diagnostic. READ-ONLY. Safe to run repeatedly.

.DESCRIPTION
  Checks, in order, every layer between "the PC is on" and "a model is running on the GPU", and writes a timestamped
  report (JSON + text) that contains NO secrets:

    1 Windows running (boot time, uptime, signed-in user, pending reboot, recent shutdowns / sleep)
    2 Power settings that stop an always-on machine (sleep / hibernate timeouts)
    3 Network to the Crestmont platform (DNS, TCP 443, HTTPS)
    4 Runner process (Docker engine, containers, restarts, the auto-start task)
    5 Runner authenticated to Crestmont (the runner's own last claim result: 503 = secret not set on the platform,
      401 "Signature mismatch" = this machine's secret differs from the platform's)
    6 Runner receiving jobs (last claim time, drafts served, last job)
    7 Ollama available, configured model installed
    8 GPU recognized (nvidia-smi: name, driver, VRAM, utilization)
    9 Optional, only with -InferenceProbe: one small real inference on the configured model, with nvidia-smi
      sampled before, during and after (loads the model; changes nothing else)

  It never changes settings, services, files outside its report folder, firewall rules or ports, and never prints the
  runner secret (only whether the file exists and its length). Runner log lines are redacted again before writing.

.PARAMETER InstallDir
  Runner install folder (default C:\CrestmontRunner).
.PARAMETER InferenceProbe
  Also run one small real inference on the configured LOCAL_MODEL (Ollama native API on 127.0.0.1:11434).
.PARAMETER OutDir
  Report folder (default <InstallDir>\state\diagnostics).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Test-Node1Dispatch.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\CrestmontRunner\Test-Node1Dispatch.ps1 -InferenceProbe
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontRunner",
  [switch]$InferenceProbe,
  [string]$OutDir = ""
)
$ErrorActionPreference = "Continue"
$started = (Get-Date).ToUniversalTime()
if (-not $OutDir) { $OutDir = Join-Path $InstallDir "state\diagnostics" }
$null = New-Item -ItemType Directory -Force -Path $OutDir
$stamp = $started.ToString("yyyyMMdd-HHmmss")
$checks = New-Object System.Collections.ArrayList

function Hide-Secret([string]$Text) {
  if (-not $Text) { return $Text }
  $t = $Text -replace '(?i)(bearer|token|secret|password|key)(["'':= ]+)[^\s"'',]{8,}', '$1$2[redacted]'
  $t = $t -replace '\b(?:sk|rk|pk|whsec|ghp|gho|github_pat)_[A-Za-z0-9_]{8,}', '[redacted]'
  $t = $t -replace '\b[0-9a-fA-F]{40,}\b', '[redacted-hex]'
  $t = $t -replace '[A-Za-z0-9+/]{48,}={0,2}', '[redacted-blob]'
  return $t
}
function Add-Check([int]$Layer, [string]$Name, $Ok, [string]$Detail, $Data = $null) {
  $row = [ordered]@{ layer = $Layer; check = $Name; ok = $Ok; detail = (Hide-Secret $Detail); at = (Get-Date).ToUniversalTime().ToString("o") }
  if ($null -ne $Data) { $row.data = $Data }
  [void]$checks.Add($row)
  $mark = "INFO"
  if ($Ok -eq $true) { $mark = "PASS" } elseif ($Ok -eq $false) { $mark = "FAIL" }
  Write-Host ("[{0}] L{1} {2}: {3}" -f $mark, $Layer, $Name, (Hide-Secret $Detail))
}
function Get-Json([string]$Uri, [int]$TimeoutSec = 10, [string]$Method = "GET", [string]$Body = $null) {
  if ($Body) { return Invoke-RestMethod -Uri $Uri -Method $Method -Body $Body -ContentType "application/json" -TimeoutSec $TimeoutSec -UseBasicParsing }
  return Invoke-RestMethod -Uri $Uri -Method $Method -TimeoutSec $TimeoutSec -UseBasicParsing
}
function Get-GpuSample {
  $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if (-not $smi) { return $null }
  $line = & $smi.Source --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null | Select-Object -First 1
  if (-not $line) { return $null }
  $p = $line -split ",\s*"
  return [ordered]@{ at = (Get-Date).ToUniversalTime().ToString("o"); name = $p[0]; driver = $p[1]; vramTotalMb = [int]$p[2]; vramUsedMb = [int]$p[3]; utilPercent = [int]$p[4]; temperatureC = $p[5]; powerW = $p[6] }
}

Write-Host "Crestmont Node 1 dispatch diagnostic (read-only) - $($started.ToString('o'))"

# -- runner configuration (non-secret values only) --
$compose = Join-Path $InstallDir "compose"
$envFile = Join-Path $compose "runner.env"
$cfg = @{}
if (Test-Path $envFile) {
  foreach ($l in Get-Content $envFile) { if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() } }
}
$showKeys = @("CONTROL_PLANE_URL", "RUNNER_ID", "RUNNER_AGENT_PROVIDER", "LOCAL_MODEL", "LOCAL_MODEL_A", "LOCAL_MODEL_B", "LOCAL_MODEL_BASE_URL", "LOCAL_MODEL_CONTEXT_TOKENS", "RUNNER_SERVE_AI_DRAFTS", "RUNNER_SLOTS", "INFERENCE_MAX_CONCURRENT", "RUNNER_ALLOW_PAID_PROVIDER", "LOG_LEVEL")
$cfgView = [ordered]@{}
foreach ($k in ($cfg.Keys | Sort-Object)) { if ($showKeys -contains $k) { $cfgView[$k] = $cfg[$k] } else { $cfgView[$k] = "(set)" } }
$platform = $cfg["CONTROL_PLANE_URL"]
$model = $cfg["LOCAL_MODEL"]; if (-not $model) { $model = $cfg["LOCAL_MODEL_B"] }
Add-Check 4 "runner configuration" (Test-Path $envFile) $(if (Test-Path $envFile) { "runner.env found; platform $platform; model $model" } else { "no runner.env at $envFile: the runner was never installed here (or in another folder: use -InstallDir)" }) $cfgView
$secretFile = Join-Path $InstallDir "secrets\build_runner_secret"
if (Test-Path $secretFile) {
  $len = (Get-Item $secretFile).Length
  Add-Check 5 "runner secret file" ($len -ge 32) ("present, {0} bytes (value not shown){1}" -f $len, $(if ($len -lt 32) { "; shorter than 32 bytes" } else { "" }))
} else { Add-Check 5 "runner secret file" $false "missing: $secretFile" }

# -- 1 Windows running --
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $boot = $os.LastBootUpTime.ToUniversalTime()
  $up = (Get-Date).ToUniversalTime() - $boot
  Add-Check 1 "Windows running" $true ("{0} build {1}; booted {2:o} (up {3:N1} h)" -f $os.Caption, $os.BuildNumber, $boot, $up.TotalHours)
} catch { Add-Check 1 "Windows running" $null "could not read Win32_OperatingSystem: $($_.Exception.Message)" }
try {
  $user = (Get-CimInstance Win32_ComputerSystem).UserName
  Add-Check 1 "interactive user signed in" ([bool]$user) $(if ($user) { "signed in: $user (Docker Desktop and the runner start only in a signed-in session)" } else { "NOBODY is signed in: the CrestmontRunner-Start task (at logon) and Docker Desktop do not run until someone signs in" })
} catch { Add-Check 1 "interactive user signed in" $null $_.Exception.Message }
$pending = (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") -or (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")
Add-Check 1 "reboot pending" (-not $pending) $(if ($pending) { "Windows has a pending reboot (updates): after it, nothing starts until someone signs in" } else { "no pending reboot" })
try {
  $since = (Get-Date).AddDays(-14)
  $ev = Get-WinEvent -FilterHashtable @{ LogName = "System"; Id = 41, 42, 1074, 6006, 6008, 107; StartTime = $since } -ErrorAction SilentlyContinue | Select-Object -First 30
  $rows = @($ev | ForEach-Object { [ordered]@{ at = $_.TimeCreated.ToUniversalTime().ToString("o"); id = $_.Id; kind = @{ 41 = "unexpected power loss"; 42 = "sleep"; 107 = "resume from sleep"; 1074 = "shutdown/restart requested"; 6006 = "clean shutdown"; 6008 = "unexpected shutdown" }[[int]$_.Id] } })
  $sleeps = @($rows | Where-Object { $_.id -eq 42 }).Count
  Add-Check 1 "shutdowns, restarts and sleep (14 days)" ($sleeps -eq 0) ("{0} events; {1} sleep entries" -f $rows.Count, $sleeps) $rows
} catch { Add-Check 1 "shutdowns, restarts and sleep (14 days)" $null $_.Exception.Message }

# -- 2 Power settings --
function Get-PowerMinutes([string]$Sub, [string]$Setting) {
  $out = (& powercfg.exe /query SCHEME_CURRENT $Sub $Setting 2>$null) | Out-String
  if ($out -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { return [int][Convert]::ToInt32($Matches[1], 16) / 60 }
  return $null
}
$sleepMin = Get-PowerMinutes "SUB_SLEEP" "STANDBYIDLE"
$hibMin = Get-PowerMinutes "SUB_SLEEP" "HIBERNATEIDLE"
Add-Check 2 "sleep on AC power" $(if ($null -eq $sleepMin) { $null } else { $sleepMin -eq 0 }) $(if ($null -eq $sleepMin) { "could not read powercfg" } elseif ($sleepMin -eq 0) { "never sleeps" } else { "sleeps after $sleepMin min idle: a sleeping PC cannot poll for work" })
Add-Check 2 "hibernate on AC power" $(if ($null -eq $hibMin) { $null } else { $hibMin -eq 0 }) $(if ($null -eq $hibMin) { "could not read powercfg" } elseif ($hibMin -eq 0) { "never hibernates" } else { "hibernates after $hibMin min idle" })

# -- 3 Network --
if ($platform) {
  try {
    $uri = [Uri]$platform
    $ips = @(Resolve-DnsName -Name $uri.Host -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })
    Add-Check 3 "DNS $($uri.Host)" ($ips.Count -gt 0) ("resolves to {0}" -f ($ips -join ", "))
    $tcp = New-Object Net.Sockets.TcpClient
    $okTcp = $tcp.ConnectAsync($uri.Host, 443).Wait(8000) -and $tcp.Connected
    $tcp.Close()
    Add-Check 3 "TCP 443 to the platform" $okTcp $(if ($okTcp) { "connected" } else { "no TCP connection within 8 s (firewall, proxy or network)" })
    try {
      $r = Invoke-WebRequest -Uri ($platform.TrimEnd("/") + "/health") -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 0 -ErrorAction Stop
      Add-Check 3 "HTTPS to the platform" $true ("GET /health -> {0}" -f $r.StatusCode)
    } catch {
      $code = $null; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      Add-Check 3 "HTTPS to the platform" $(if ($code) { $true } else { $false }) $(if ($code) { "GET /health -> HTTP $code (the server answered)" } else { "no HTTPS answer: $($_.Exception.Message)" })
    }
  } catch { Add-Check 3 "platform URL" $false "CONTROL_PLANE_URL is not a valid URL: $platform" }
} else { Add-Check 3 "platform URL" $false "CONTROL_PLANE_URL not configured (runner.env missing or incomplete)" }

# -- 4 Runner process --
$dockerDesktop = Get-Process -Name "Docker Desktop", "com.docker.backend" -ErrorAction SilentlyContinue
Add-Check 4 "Docker Desktop running" ([bool]$dockerDesktop) $(if ($dockerDesktop) { "running" } else { "not running (starts only in a signed-in session)" })
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
$engine = $false
if ($docker) { & docker.exe info --format "{{.ServerVersion}}" 2>$null | Out-Null; $engine = ($LASTEXITCODE -eq 0) }
Add-Check 4 "Docker engine answering" $engine $(if ($engine) { "docker info OK" } elseif ($docker) { "docker.exe present but the engine does not answer" } else { "docker.exe not found" })
$health = $null
if ($engine -and (Test-Path (Join-Path $compose "docker-compose.yml"))) {
  $base = @("compose", "-f", (Join-Path $compose "docker-compose.yml"), "--project-directory", $compose)
  $ps = (& docker.exe @($base + @("ps", "-a", "--format", "{{.Service}}|{{.State}}|{{.Status}}|{{.Image}}")) 2>&1 | Out-String).Trim()
  $svc = @($ps -split "`r?`n" | Where-Object { $_ -match '\|' } | ForEach-Object { $p = $_ -split '\|'; [ordered]@{ service = $p[0]; state = $p[1]; status = $p[2]; image = $p[3] } })
  $runnerSvc = $svc | Where-Object { $_.service -eq "runner" } | Select-Object -First 1
  Add-Check 4 "runner container" $(if ($runnerSvc) { $runnerSvc.state -eq "running" } else { $false }) $(if ($runnerSvc) { "$($runnerSvc.state): $($runnerSvc.status) ($($runnerSvc.image))" } else { "no runner container in this compose project" }) $svc
  if ($runnerSvc) {
    $restarts = (& docker.exe @($base + @("ps", "-q", "runner")) | ForEach-Object { & docker.exe inspect --format "{{.RestartCount}}|{{.State.StartedAt}}" $_ }) | Select-Object -First 1
    if ($restarts) { $rp = $restarts -split '\|'; Add-Check 4 "runner restarts" ([int]$rp[0] -lt 5) ("restart count {0}; started {1}" -f $rp[0], $rp[1]) }
    $json = (& docker.exe @($base + @("exec", "-T", "runner", "node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(t=>console.log(t),e=>{console.log(JSON.stringify({status:'unreachable',error:String(e)}));process.exit(1)})")) 2>&1 | Out-String).Trim()
    try { $health = $json | ConvertFrom-Json } catch { $health = $null }
    Add-Check 4 "runner health endpoint" ([bool]$health) $(if ($health) { "status $($health.status); version $($health.version)" } else { "no health JSON: $json" })
    $logs = (& docker.exe @($base + @("logs", "--tail", "300", "runner")) 2>&1 | Out-String) -split "`r?`n"
    $interesting = @($logs | Where-Object { $_ -match 'claim failed|lease|AI draft|diagnostic|model server|401|403|503|Signature|ECONN|ETIMEDOUT|fetch failed|error' } | Select-Object -Last 40 | ForEach-Object { Hide-Secret $_ })
    Add-Check 4 "runner log (relevant lines, redacted)" $null ("{0} of the last 300 lines" -f $interesting.Count) $interesting
  }
}
try {
  $task = Get-ScheduledTask -TaskName "CrestmontRunner-Start" -ErrorAction Stop
  $info = $task | Get-ScheduledTaskInfo
  $trig = ($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ", "
  Add-Check 4 "auto-start task" ($info.LastTaskResult -eq 0) ("state {0}; trigger {1}; last run {2}; last result 0x{3:X}" -f $task.State, $trig, $info.LastRunTime, $info.LastTaskResult)
} catch { Add-Check 4 "auto-start task" $false "CrestmontRunner-Start is not registered: nothing starts the runner after a reboot" }

# -- 5 / 6 Authenticated and receiving work (the runner's own record) --
if ($health) {
  $err = "$($health.lastClaimError)"
  $why = "last claim OK"
  if ($health.lastClaimOk -ne $true) {
    if ($err -match '503') { $why = "the platform answers 503: BUILD_RUNNER_SECRET is not set on the platform" }
    elseif ($err -match '401|Signature') { $why = "the platform rejects the signature: this machine's runner secret differs from the platform's (or the clock is off by more than 10 min)" }
    elseif ($err -match '404') { $why = "the platform does not have this endpoint: runner and platform versions differ" }
    elseif ($err) { $why = "claim error: $err" } else { $why = "no claim recorded yet" }
  }
  Add-Check 5 "authenticated to Crestmont" ($health.lastClaimOk -eq $true) ("{0} (last claim {1})" -f $why, $health.lastClaimAt)
  Add-Check 6 "receiving jobs" $null ("drafts served {0}; jobs {1}; last job outcome {2}; last draft error {3}" -f $health.draftsServed, $health.jobsRun, $health.lastJobOutcome, $health.lastDraftError)
} else { Add-Check 5 "authenticated to Crestmont" $null "unknown: the runner's health endpoint is not available" }
Add-Check 5 "clock" $null ("local UTC {0:o} (signatures are refused beyond 10 minutes of skew)" -f (Get-Date).ToUniversalTime())

# -- 7 Ollama --
$ollamaBase = "http://127.0.0.1:11434"
$ollamaOk = $false
try {
  $v = Get-Json "$ollamaBase/api/version" 5
  $ollamaOk = $true
  Add-Check 7 "Ollama answering" $true "version $($v.version) on 127.0.0.1:11434"
} catch { Add-Check 7 "Ollama answering" $false "no answer on 127.0.0.1:11434: $($_.Exception.Message) (ollama-in-docker installs answer inside Docker instead)" }
if ($ollamaOk) {
  try {
    $tags = Get-Json "$ollamaBase/api/tags" 10
    $names = @($tags.models | ForEach-Object { $_.name })
    $have = $false
    if ($model) { $have = ($names -contains $model) -or ($names -contains "$model`:latest") }
    Add-Check 7 "configured model installed" $have $(if ($model) { "LOCAL_MODEL $model is $(if ($have) { 'installed' } else { 'NOT installed' }); installed: $($names -join ', ')" } else { "no model configured; installed: $($names -join ', ')" }) $names
    $psNow = Get-Json "$ollamaBase/api/ps" 10
    $loaded = @($psNow.models | ForEach-Object { [ordered]@{ name = $_.name; sizeMb = [math]::Round($_.size / 1MB); vramMb = [math]::Round($_.size_vram / 1MB) } })
    Add-Check 7 "models loaded now" $null ("{0} loaded" -f $loaded.Count) $loaded
  } catch { Add-Check 7 "Ollama models" $false $_.Exception.Message }
}

# -- 8 GPU --
$g = Get-GpuSample
Add-Check 8 "GPU (nvidia-smi)" ([bool]$g) $(if ($g) { "{0}, driver {1}, VRAM {2}/{3} MB used, {4}% util" -f $g.name, $g.driver, $g.vramUsedMb, $g.vramTotalMb, $g.utilPercent } else { "nvidia-smi not found or no GPU reported" }) $g

# -- 9 Optional real inference --
if ($InferenceProbe) {
  if (-not ($ollamaOk -and $model)) { Add-Check 9 "inference probe" $false "skipped: Ollama not answering or no model configured" }
  else {
    $before = Get-GpuSample
    $samples = New-Object System.Collections.ArrayList
    $smiPath = (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue).Source
    $sampler = $null
    if ($smiPath) { $sampler = Start-Job -ScriptBlock { param($p) for ($i = 0; $i -lt 240; $i++) { & $p --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits; Start-Sleep -Milliseconds 500 } } -ArgumentList $smiPath }
    $body = @{ model = $model; stream = $false; keep_alive = "10m"; options = @{ temperature = 0; seed = 42; num_predict = 400 }
      messages = @(@{ role = "system"; content = "Reply with one complete HTML document and nothing else." }, @{ role = "user"; content = "Generate a minimal HTML document containing a title, heading and paragraph for a fictional junk removal company called Junk in the Trunk." }) } | ConvertTo-Json -Depth 5
    try {
      $t0 = Get-Date
      $res = Get-Json "$ollamaBase/api/chat" 300 "POST" $body
      $wall = ((Get-Date) - $t0).TotalMilliseconds
      if ($sampler) { Stop-Job $sampler; foreach ($l in (Receive-Job $sampler)) { $p = "$l" -split ",\s*"; if ($p.Count -ge 2) { [void]$samples.Add([ordered]@{ vramUsedMb = [int]$p[0]; utilPercent = [int]$p[1] }) } }; Remove-Job $sampler -Force }
      $after = Get-GpuSample
      $peakUtil = 0; $peakVram = 0
      foreach ($s in $samples) { if ($s.utilPercent -gt $peakUtil) { $peakUtil = $s.utilPercent }; if ($s.vramUsedMb -gt $peakVram) { $peakVram = $s.vramUsedMb } }
      $psAfter = Get-Json "$ollamaBase/api/ps" 10
      $res2 = $psAfter.models | Where-Object { $_.name -eq $model -or $_.name -eq "$model`:latest" } | Select-Object -First 1
      $evalMs = [math]::Round($res.eval_duration / 1e6)
      $tps = 0; if ($evalMs -gt 0) { $tps = [math]::Round($res.eval_count / ($evalMs / 1000), 1) }
      $content = "$($res.message.content)"
      $outFile = Join-Path $OutDir "node1-inference-$stamp.html"
      Set-Content -Encoding utf8 -Path $outFile -Value $content
      $gpuPct = $null; if ($res2 -and $res2.size) { $gpuPct = [math]::Round(100 * $res2.size_vram / $res2.size) }
      Add-Check 9 "inference probe" ([bool]$content -and $peakUtil -gt 0) ("model {0}: {1} tokens in {2} ms ({3} tok/s); load {4} ms; total {5} ms (wall {6:N0} ms); in GPU memory {7}%; GPU peak {8}% util, {9} MB VRAM; output {10} chars -> {11}" -f $res.model, $res.eval_count, $evalMs, $tps, [math]::Round($res.load_duration / 1e6), [math]::Round($res.total_duration / 1e6), $wall, $gpuPct, $peakUtil, $peakVram, $content.Length, $outFile) ([ordered]@{ before = $before; after = $after; samples = $samples.Count; peakUtilPercent = $peakUtil; peakVramMb = $peakVram })
    } catch {
      if ($sampler) { Stop-Job $sampler -ErrorAction SilentlyContinue; Remove-Job $sampler -Force -ErrorAction SilentlyContinue }
      Add-Check 9 "inference probe" $false "Ollama /api/chat failed for $($model): $($_.Exception.Message)"
    }
  }
}

# -- summary --
$first = $checks | Where-Object { $_.ok -eq $false } | Select-Object -First 1
$summary = if ($first) { "FIRST FAILING LAYER: L$($first.layer) $($first.check) - $($first.detail)" } else { "No failing check." }
Write-Host ""
Write-Host $summary -ForegroundColor $(if ($first) { "Yellow" } else { "Green" })
$report = [ordered]@{ schema = "crestmont.node1-diagnostic/1"; host = $env:COMPUTERNAME; startedUtc = $started.ToString("o"); finishedUtc = (Get-Date).ToUniversalTime().ToString("o"); inferenceProbe = [bool]$InferenceProbe; summary = $summary; checks = $checks }
$jsonPath = Join-Path $OutDir "node1-diagnostic-$stamp.json"
$txtPath = Join-Path $OutDir "node1-diagnostic-$stamp.txt"
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -Path $jsonPath
($checks | ForEach-Object { "L{0} {1,-40} {2,-5} {3}" -f $_.layer, $_.check, $(if ($_.ok -eq $true) { "PASS" } elseif ($_.ok -eq $false) { "FAIL" } else { "INFO" }), $_.detail }) + @("", $summary) | Set-Content -Encoding utf8 -Path $txtPath
Write-Host "Report: $jsonPath"
Write-Host "        $txtPath"
Write-Host "It contains no secrets. Attach the .txt (or .json) file to the Claude conversation."
if ($first) { exit 1 } else { exit 0 }

<#
.SYNOPSIS
  Gathers the evidence for the controlled internal validation build (docs/ai-builds/LOCAL-VALIDATION.md) into
  <InstallDir>\evidence\<timestamp>\ . Read-only towards the runner: it copies logs and artifacts, it does not change
  configuration. It never copies the secrets folder or secret values (runner.env contains no secret values).

.DESCRIPTION
  Two modes:
    -Monitor -Minutes 90     sample CPU / RAM / GPU (nvidia-smi) every -IntervalSeconds into utilization.csv while the
                             validation build runs (start it right after queuing the build).
    -JobId bld_...           collect everything about that build after it finished (or was cancelled).
  Both can be combined; -Monitor runs first. To keep a monitor run and the later job collection in ONE folder, pass
  the same -EvidenceDir to both. Without it, a -JobId collection copies utilization.csv from the most recent -Monitor
  folder (written in the last 24 hours) and records which one in EVIDENCE-INDEX.txt.

  Collected (when available):
    hardware.json, recommendation.json      machine + model decision
    ollama-version.txt, ollama-list.txt, ollama-ps.txt, ollama-server*.log
                                            proof of LOCAL inference (POST /v1/chat/completions lines, GPU/CPU split)
    proxy-access.log, proxy-summary.txt     every outbound request of the runner + build containers; anthropic.com
                                            and other paid AI hosts counted (expected: 0 allowed)
    runner.log, runner-job.log              runner JSON lines (all / this job)
    docker-ps.txt, docker-inspect-*.json    containers still present and their isolation flags
    workspace\<ref>\_runner-evidence\      sandbox-isolation-NN.json: docker inspect of EVERY build container the job
                                            ran, judged by the runner (kept after the containers are removed)
    listening-ports.txt, firewall-inbound.txt
                                            no public listener, no inbound rules added
    workspace\                              generated source, .crestmont status files, runner-checks.json, screenshots
    health.txt, utilization.csv, EVIDENCE-INDEX.txt (which LOCAL-VALIDATION.md evidence is present / missing),
    MANIFEST.txt (SHA-256 of every file)
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\CrestmontRunner",
  [string]$JobId = "",
  [switch]$Monitor,
  [int]$Minutes = 60,
  [int]$IntervalSeconds = 15,
  [string]$EvidenceDir = ""
)
$ErrorActionPreference = "Continue"
if ($JobId -and $JobId -cnotmatch '^[A-Za-z0-9_-]{1,80}$') { throw "-JobId must look like bld_..." }
$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$suffix = if ($JobId) { "-$JobId" } elseif ($Monitor) { "-monitor" } else { "" }
$out = if ($EvidenceDir) { $EvidenceDir } else { Join-Path $InstallDir "evidence\$stamp$suffix" }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$compose = Join-Path $InstallDir "compose"
$dc = @("compose", "-f", (Join-Path $compose "docker-compose.yml"), "--project-directory", $compose)
function Save([string]$Name, $Content) { $Content | Out-File -Encoding utf8 (Join-Path $out $Name) }
function Note([string]$m) { Write-Host $m; Add-Content -Path (Join-Path $out "collector.log") -Value $m }

if ($Monitor) {
  Note "Sampling utilization for $Minutes minutes every $IntervalSeconds s -> utilization.csv"
  $csv = Join-Path $out "utilization.csv"
  "timestamp,cpu_percent,ram_used_gb,ram_total_gb,gpu_util_percent,gpu_mem_used_gb,docker_cpu,docker_mem" | Set-Content $csv
  $nvsmi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
  $end = (Get-Date).AddMinutes($Minutes)
  while ((Get-Date) -lt $end) {
    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $os = Get-CimInstance Win32_OperatingSystem
    $ramTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $ramUsed = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 1)
    $gUtil = ""; $gMem = ""
    if ($nvsmi) {
      $g = (& $nvsmi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits | Select-Object -First 1) -split ",\s*"
      if ($g.Count -ge 2) { $gUtil = $g[0]; $gMem = [math]::Round([double]$g[1] / 1024, 2) }
    }
    $ds = (& docker.exe stats --no-stream --format "{{.Name}}={{.CPUPerc}}/{{.MemUsage}}" 2>$null) -join " "
    $ds = $ds -replace ",", ";"
    "{0},{1},{2},{3},{4},{5},{6}" -f (Get-Date).ToString("o"), $cpu, $ramUsed, $ramTotal, $gUtil, $gMem, $ds | Add-Content $csv
    Start-Sleep -Seconds $IntervalSeconds
  }
}

Note "Collecting evidence into $out"
# Machine and model decision.
Copy-Item -ErrorAction SilentlyContinue (Join-Path $InstallDir "state\hardware.json"), (Join-Path $InstallDir "state\recommendation.json") $out
& (Join-Path $PSScriptRoot "Discover-Hardware.ps1") | Out-File -Encoding utf8 (Join-Path $out "hardware-now.json")

# Local inference proof (Ollama documents logs in %LOCALAPPDATA%\Ollama: server.log, app.log).
$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if ($ollama) {
  Save "ollama-version.txt" (& $ollama --version 2>&1)
  Save "ollama-list.txt" (& $ollama list 2>&1)
  Save "ollama-ps.txt" (& $ollama ps 2>&1)
}
Get-ChildItem (Join-Path $env:LOCALAPPDATA "Ollama") -Filter "server*.log" -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName (Join-Path $out ("ollama-" + $_.Name)) }
& docker.exe @($dc + @("logs", "--no-color", "--timestamps", "ollama")) 2>$null | Out-File -Encoding utf8 (Join-Path $out "ollama-container.log")

# Egress: every request through the allow-list proxy.
& docker.exe @($dc + @("logs", "--no-color", "--timestamps", "egress-proxy")) 2>&1 | Out-File -Encoding utf8 (Join-Path $out "proxy-access.log")
$lines = Get-Content (Join-Path $out "proxy-access.log") -ErrorAction SilentlyContinue
# Same hosted-AI domains the proxy denies (squid.conf.template paid_ai / paid_ai_re; kept in sync by a runner test).
$paidPattern = '(^|[\s/.])(anthropic\.com|claude\.ai|claude\.com|openai\.com|openai\.azure\.com|mistral\.ai|googleapis\.com|openrouter\.ai|groq\.com|together\.xyz|together\.ai|fireworks\.ai|cohere\.ai|cohere\.com|deepseek\.com|x\.ai|perplexity\.ai|replicate\.com|api-inference\.huggingface\.co|router\.huggingface\.co|bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com)([:/\s]|$)'
$paid = @($lines | Where-Object { $_ -match $paidPattern })
$paidAllowed = @($paid | Where-Object { $_ -notmatch "TCP_DENIED" })
$hosts = $lines | ForEach-Object { if ($_ -match "\s(CONNECT|GET|POST|HEAD)\s+(\S+)") { ($matches[2] -replace "^https?://", "") -replace "[:/].*$", "" } } | Group-Object | Sort-Object Count -Descending
Save "proxy-summary.txt" @(
  "Requests to paid AI hosts (any result): $($paid.Count)"
  "Requests to paid AI hosts NOT denied:   $($paidAllowed.Count)   (expected 0)"
  ""
  "Destinations (count host):"
  ($hosts | ForEach-Object { "{0,7} {1}" -f $_.Count, $_.Name })
)

# Runner logs (JSON lines, secrets redacted by the runner).
& docker.exe @($dc + @("logs", "--no-color", "runner")) 2>&1 | Out-File -Encoding utf8 (Join-Path $out "runner.log")
if ($JobId) { Get-Content (Join-Path $out "runner.log") | Where-Object { $_ -match [Regex]::Escape($JobId) } | Out-File -Encoding utf8 (Join-Path $out "runner-job.log") }

# Containers and isolation flags.
Save "docker-ps.txt" (& docker.exe ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Networks}}\t{{.Ports}}" 2>&1)
foreach ($c in @(& docker.exe ps -a --filter "label=crestmont.role=build-sandbox" --format "{{.Names}}" 2>$null) + @(& docker.exe @($dc + @("ps", "-q")) 2>$null)) {
  if ($c) { & docker.exe inspect --format "{{json .HostConfig}}" $c 2>$null | Out-File -Encoding utf8 (Join-Path $out "docker-inspect-$($c.Substring(0, [math]::Min(40, $c.Length))).json") }
}

# No public port, no inbound rules.
Save "listening-ports.txt" (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Sort-Object LocalPort |
  ForEach-Object { "{0,-40} {1,6} pid {2} {3}" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess, ((Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName) })
Save "firewall-inbound.txt" (Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match "ollama|docker|crestmont|squid|node" } | Select-Object DisplayName, Profile, Action | Format-Table -AutoSize | Out-String)

# Utilization: from this folder's own -Monitor run, else the most recent monitor folder of the last 24 hours.
$utilSource = "none"
if (Test-Path (Join-Path $out "utilization.csv")) { $utilSource = "this folder (-Monitor)" }
elseif ($JobId) {
  $recent = Get-ChildItem (Join-Path $InstallDir "evidence") -Directory -Filter "*-monitor" -ErrorAction SilentlyContinue |
    Where-Object { (Test-Path (Join-Path $_.FullName "utilization.csv")) -and $_.LastWriteTime -gt (Get-Date).AddHours(-24) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($recent) { Copy-Item (Join-Path $recent.FullName "utilization.csv") $out; $utilSource = "copied from $($recent.FullName)" }
}

# Workspace artifacts of the job (generated source, status files, screenshots) from the workspaces volume.
if ($JobId) {
  $safe = $JobId -replace "[^A-Za-z0-9_-]", "_"
  New-Item -ItemType Directory -Force -Path (Join-Path $out "workspace") | Out-Null
  # Shell script kept in a single-quoted here-string so PowerShell does not expand $d; JOBPREFIX is substituted.
  $sh = @'
for d in /w/JOBPREFIX-a*; do
  [ -d "$d/repo" ] || continue
  n=$(basename "$d")
  mkdir -p "/out/$n" && cp -r "$d/repo/." "/out/$n/"
  ls -l "$d/agent" > "/out/$n/AGENT-TRANSCRIPTS.txt" 2>/dev/null
  [ -d "$d/evidence" ] && mkdir -p "/out/$n/_runner-evidence" && cp "$d/evidence/"*.json "/out/$n/_runner-evidence/" 2>/dev/null
done
true
'@
  $sh = $sh.Replace("JOBPREFIX", $safe)
  & docker.exe run --rm --network none -v crestmont-workspaces:/w:ro -v "$(Join-Path $out 'workspace'):/out" --entrypoint sh crestmont-ai-runner:1 -c $sh
}

try { & (Join-Path $PSScriptRoot "Get-RunnerHealth.ps1") -InstallDir $InstallDir | Out-File -Encoding utf8 (Join-Path $out "health.txt") }
catch { "Get-RunnerHealth.ps1 failed: $($_.Exception.Message)" | Out-File -Encoding utf8 (Join-Path $out "health.txt") }

# Index: each evidence row of LOCAL-VALIDATION.md section 5 and whether this folder has it.
function Has([string]$Pattern) { if (@(Get-ChildItem $out -Recurse -File -Filter $Pattern -ErrorAction SilentlyContinue).Count) { "present" } else { "MISSING" } }
Save "EVIDENCE-INDEX.txt" @(
  "Evidence folder: $out"
  "Build: $(if ($JobId) { $JobId } else { '(none: -JobId not given)' })"
  ""
  "Local inference          ollama-server*.log, ollama-ps.txt     $(Has 'ollama-*.log') / $(Has 'ollama-ps.txt')"
  "Zero paid AI calls       proxy-summary.txt                    $(Has 'proxy-summary.txt')"
  "Generated source         workspace\<ref>\                       $(Has 'BRIEF.md')"
  "Checks and report        runner-job.log                        $(Has 'runner-job.log')"
  "Screenshots              workspace\<ref>\.crestmont\screenshots $(Has '*.png')"
  "Sandbox isolation        workspace\<ref>\_runner-evidence\     $(Has 'sandbox-isolation-*.json')"
  "No public port           listening-ports.txt                   $(Has 'listening-ports.txt')"
  "Utilization              utilization.csv                       $(Has 'utilization.csv') ($utilSource)"
  "Health                   health.txt                            $(Has 'health.txt')"
  ""
  "Add by hand: owner-review.txt (preview review), drills.txt (revision, cancel, crash recovery)."
)

# Manifest with hashes.
Get-ChildItem $out -Recurse -File | Where-Object { $_.Name -ne "MANIFEST.txt" } |
  ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.FullName.Substring($out.Length + 1) } |
  Out-File -Encoding utf8 (Join-Path $out "MANIFEST.txt")
Note "Done: $out"
Note "Still to add by hand (see LOCAL-VALIDATION.md): owner preview review notes, cancellation + recovery drill notes."

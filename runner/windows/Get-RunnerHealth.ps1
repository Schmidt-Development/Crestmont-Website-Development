<#
.SYNOPSIS
  Prints the runner's health JSON and container states. Read-only.
  The health endpoint listens on 127.0.0.1 INSIDE the runner container only (no published port); this script reads
  it with `docker exec`. Exit code 0 = healthy. The JSON carries status fields only (no secrets): control-plane claim
  status, model server reachability (checked by the runner every few minutes), and the last job, draft and model
  errors (truncated, secrets redacted).
#>
[CmdletBinding()]
param([string]$InstallDir = "C:\CrestmontRunner")
$compose = Join-Path $InstallDir "compose"
$base = @("compose", "-f", (Join-Path $compose "docker-compose.yml"), "--project-directory", $compose)
# Founder V3 (-Provider ClaudeCode): one orchestrator container per Claude account instead of the local-model runner.
$claudeOverlay = Join-Path $compose "docker-compose.claude.yml"
$services = @("runner")
if (Test-Path $claudeOverlay) { $base += @("-f", $claudeOverlay); $services = @("claude-1", "claude-2", "claude-3") }
& docker.exe @($base + @("ps", "--format", "table {{.Service}}\t{{.State}}\t{{.Status}}"))
$allOk = $true
foreach ($svc in $services) {
  Write-Host ""
  Write-Host "== $svc =="
  $json = & docker.exe @($base + @("exec", "-T", $svc, "node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(t=>{console.log(t)},e=>{console.log(JSON.stringify({status:'unreachable',error:String(e)}));process.exit(1)})")) 2>&1 | Out-String
  Write-Host $json
  $h = $null
  try { $h = $json | ConvertFrom-Json } catch { Write-Host "Health output is not JSON: $($_.Exception.Message)"; $allOk = $false; continue }
  if ($null -ne $h.modelReachable) {
    $state = if ($h.modelReachable) { "reachable" } else { "NOT reachable" }
    Write-Host "Model server: $state (model $($h.model), checked $($h.modelCheckedAt))"
    if ($h.lastModelError) { Write-Host "Last model error: $($h.lastModelError)" }
    if ($null -ne $h.modelGpuShare) {
      $pct = [int][math]::Round([double]$h.modelGpuShare * 100)
      if ($pct -ge 100) { Write-Host "Model GPU residency: 100% (fully in GPU memory)" }
      else { Write-Host "Model GPU residency: $pct% - part of the model runs on the CPU; builds will be slow (choose a smaller model or context)" }
    }
  }
  if ($h.lastJobError) { Write-Host "Last job ($($h.lastJobOutcome)): $($h.lastJobError)" }
  if ($h.status -ne "ok") { $allOk = $false }
}
if ($services -contains "runner") {
  $ollama = $null
  try { $ollama = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 5 } catch { Write-Verbose "Ollama version probe failed: $($_.Exception.Message)" }
  if ($ollama) { Write-Host "Ollama (native) version $($ollama.version) on 127.0.0.1:11434" } else { Write-Host "Ollama not answering on 127.0.0.1:11434 (fine if you use -OllamaInDocker)" }
}
if ($allOk) { exit 0 } else { exit 1 }

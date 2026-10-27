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
& docker.exe @($base + @("ps", "--format", "table {{.Service}}\t{{.State}}\t{{.Status}}"))
$json = & docker.exe @($base + @("exec", "-T", "runner", "node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(t=>{console.log(t)},e=>{console.log(JSON.stringify({status:'unreachable',error:String(e)}));process.exit(1)})")) 2>&1 | Out-String
Write-Host $json
$h = $null
try { $h = $json | ConvertFrom-Json } catch { Write-Host "Health output is not JSON: $($_.Exception.Message)"; exit 1 }
if ($null -ne $h.modelReachable) {
  $state = if ($h.modelReachable) { "reachable" } else { "NOT reachable" }
  Write-Host "Model server: $state (model $($h.model), checked $($h.modelCheckedAt))"
  if ($h.lastModelError) { Write-Host "Last model error: $($h.lastModelError)" }
}
if ($h.lastJobError) { Write-Host "Last job ($($h.lastJobOutcome)): $($h.lastJobError)" }
$ollama = $null
try { $ollama = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 5 } catch { Write-Verbose "Ollama version probe failed: $($_.Exception.Message)" }
if ($ollama) { Write-Host "Ollama (native) version $($ollama.version) on 127.0.0.1:11434" } else { Write-Host "Ollama not answering on 127.0.0.1:11434 (fine if you use -OllamaInDocker)" }
if ($h.status -eq "ok") { exit 0 } else { exit 1 }

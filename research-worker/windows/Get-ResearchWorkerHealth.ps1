<# .SYNOPSIS Shows the research worker's health (127.0.0.1 only): queue, today's counters, sources, platform link. #>
[CmdletBinding()] param([int]$Port = 8789)
try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5 | ConvertTo-Json -Depth 6 }
catch { Write-Host "Worker not answering on 127.0.0.1:$Port ($($_.Exception.Message)). Check logs\worker-*.log and the CrestmontResearch-Worker task." -ForegroundColor Red; exit 1 }

<#
.SYNOPSIS
  Native Ollama checks for Install-CrestmontRunner.ps1 (dot-sourced): is the Ollama API answering, is it localhost
  only, and are the exact model tags present. Reads only; never starts, stops or reconfigures Ollama.

.DESCRIPTION
  Why this exists (Node 1, Windows build 26300): Ollama was serving on 127.0.0.1:11434 (`ollama ps` worked,
  Test-NetConnection succeeded, netstat showed established connections) while
  `Get-NetTCPConnection -LocalPort 11434 -State Listen` returned nothing, so the installer stopped with
  "Ollama is not listening on port 11434". A TCP listener list is therefore not proof either way. The checks are:

    1. Liveness = the Ollama API itself: GET http://127.0.0.1:11434/api/version must return JSON with a version
       (no proxy; an accepted TCP connection alone is not enough).
    2. Localhost only, from several independent sources; any one of them showing exposure stops the install:
       a. OLLAMA_HOST in the Process, User and Machine scopes must bind to a loopback address (unset = 127.0.0.1).
       b. Listeners for the port from Get-NetTCPConnection, .NET GetActiveTcpListeners() and netstat -ano (union).
          Every listed address must be loopback.
       c. An active probe: a TCP connect to the port on every non-loopback address of this machine must FAIL.
          This runs always, and it is what proves localhost-only when (b) lists nothing (the Node 1 behaviour).
    3. Model tags: exact names from GET /api/tags (a bare name means :latest).

  The decision functions (Resolve-CrestmontOllamaExposure, Get-CrestmontOllamaHostBind, ConvertFrom-CrestmontNetstatListen,
  Find-CrestmontMissingModel, Test-CrestmontLoopbackAddress) are pure and tested from runner/test/ollama-probe.test.ts
  wherever pwsh is available (CI). The collectors (Get-CrestmontOllamaListener, Get-CrestmontNonLoopbackAddress,
  Test-CrestmontTcpPort, Invoke-CrestmontOllamaApi) touch the machine read-only.
  Works in Windows PowerShell 5.1 and PowerShell 7. ASCII only.
#>

function Test-CrestmontLoopbackAddress([string]$Address) {
  $a = "$Address".Trim()
  if ($a.StartsWith("[") -and $a.EndsWith("]")) { $a = $a.Substring(1, $a.Length - 2) }
  $pct = $a.IndexOf("%"); if ($pct -ge 0) { $a = $a.Substring(0, $pct) }
  if (-not $a) { return $false }
  if ($a -eq "localhost") { return $true }
  $ip = $null
  if (-not [System.Net.IPAddress]::TryParse($a, [ref]$ip)) { return $false }
  if ($ip.IsIPv4MappedToIPv6) { $ip = $ip.MapToIPv4() }
  return [System.Net.IPAddress]::IsLoopback($ip)
}

# The address Ollama binds for an OLLAMA_HOST value, the way Ollama reads it (envconfig.Host): optional scheme, then
# host[:port]; unset/empty = 127.0.0.1; an empty host (":11434") or 0.0.0.0 / :: = every interface.
function Get-CrestmontOllamaHostBind([string]$Value) {
  $v = "$Value".Trim()
  if (-not $v) { return [pscustomobject]@{ value = ""; bindHost = "127.0.0.1"; loopback = $true } }
  $rest = $v
  if ($rest -match '^[A-Za-z][A-Za-z0-9+.-]*://(.*)$') { $rest = $Matches[1] }
  $rest = ($rest -split '/', 2)[0]
  if ($rest -match '^\[([^\]]*)\](:[0-9]*)?$') { $h = $Matches[1] }
  elseif ($rest -match '^([^:]*):([0-9]*)$') { $h = $Matches[1] }
  else { $h = $rest }
  return [pscustomobject]@{ value = $v; bindHost = $h; loopback = (Test-CrestmontLoopbackAddress $h) }
}

# Listening sockets for -Port from `netstat -ano` text. Locale-independent: a TCP listener is the row whose foreign
# address is 0.0.0.0:0 or [::]:0 (the state word is translated on non-English Windows). Established rows are ignored.
function ConvertFrom-CrestmontNetstatListen([string]$Text, [int]$Port) {
  $out = New-Object System.Collections.ArrayList
  foreach ($line in ("$Text" -split "`r?`n")) {
    $t = @($line.Trim() -split '\s+')
    if ($t.Count -lt 3 -or $t[0] -notmatch '^TCP') { continue }
    $local = $t[1]; $remote = $t[2]
    if ($remote -notin @("0.0.0.0:0", "[::]:0", "*:*")) { continue }
    $i = $local.LastIndexOf(":")
    if ($i -lt 0 -or $local.Substring($i + 1) -ne "$Port") { continue }
    $addr = $local.Substring(0, $i)
    if ($addr.StartsWith("[") -and $addr.EndsWith("]")) { $addr = $addr.Substring(1, $addr.Length - 2) }
    $owner = $null; if ($t[-1] -match '^[0-9]+$') { $owner = [int]$t[-1] }
    [void]$out.Add([pscustomobject]@{ address = $addr; pid = $owner; source = "netstat" })
  }
  return $out.ToArray()
}

# Wanted tags missing from the available list (exact tag, case-insensitive like Ollama; bare name = :latest).
function Find-CrestmontMissingModel([string[]]$Wanted, [string[]]$Available) {
  $norm = { param($n) $s = "$n".Trim(); if ($s -and -not $s.Contains(":")) { $s = "${s}:latest" }; $s }
  $have = @($Available | Where-Object { $_ } | ForEach-Object { & $norm $_ })
  $missing = @($Wanted | Where-Object { $_ } | ForEach-Object { & $norm $_ } | Where-Object { $have -notcontains $_ })
  return $missing
}

<#
  The decision. Inputs are what the collectors found; output: ok, problems (each stops the install), warnings, evidence.
  -Version: the version string /api/version returned ($null/empty = API not answering; -ApiError says why).
  -Listener: objects with .address (and optional .pid/.source). Empty = no source listed a listener.
  -HostSetting: scope -> OLLAMA_HOST value (Process/User/Machine).
  -ProbedAddress / -ExposedAddress: non-loopback addresses probed, and those where the port accepted a connection.
#>
function Resolve-CrestmontOllamaExposure {
  param(
    [string]$Version,
    [string]$ApiError = "",
    [object[]]$Listener = @(),
    [string[]]$ListenerSource = @(),
    [hashtable]$HostSetting = @{},
    [string[]]$ProbedAddress = @(),
    [string[]]$ExposedAddress = @(),
    [int]$Port = 11434
  )
  $problems = New-Object System.Collections.ArrayList
  $warnings = New-Object System.Collections.ArrayList
  $apiOk = [bool]("$Version".Trim())
  if (-not $apiOk) {
    $why = if ($ApiError) { " ($ApiError)" } else { "" }
    [void]$problems.Add("The Ollama API does not answer at http://127.0.0.1:${Port}/api/version$why. Start Ollama (or wait until it has started) and re-run; a port that only accepts TCP connections is not enough.")
  }
  foreach ($scope in @("Process", "User", "Machine")) {
    if (-not $HostSetting.ContainsKey($scope)) { continue }
    $b = Get-CrestmontOllamaHostBind "$($HostSetting[$scope])"
    if (-not $b.loopback) {
      $shown = if ($b.bindHost) { $b.bindHost } else { "every interface" }
      [void]$problems.Add("OLLAMA_HOST ($scope scope) is '$($b.value)', which binds Ollama to ${shown}: it must be localhost only (127.0.0.1:$Port, or unset). Changing it is the Ollama owner's decision; the installer does not change it.")
    }
  }
  $listenerList = @($Listener | Where-Object { $_ -and "$($_.address)" })
  $public = @($listenerList | Where-Object { -not (Test-CrestmontLoopbackAddress "$($_.address)") } | ForEach-Object { "$($_.address)" } | Sort-Object -Unique)
  if ($public.Count) { [void]$problems.Add("Port $Port listens on $($public -join ', '): Ollama must be localhost only. Remove OLLAMA_HOST overrides (system scope too) and any port proxy for $Port.") }
  $exposed = @($ExposedAddress | Where-Object { $_ } | Sort-Object -Unique)
  if ($exposed.Count) { [void]$problems.Add("Port $Port accepts connections on non-loopback address(es) $($exposed -join ', '): Ollama (or a forwarder) is reachable beyond this machine. It must be localhost only.") }
  $probed = @($ProbedAddress | Where-Object { $_ } | Sort-Object -Unique)
  if (-not $listenerList.Count) {
    $src = if (@($ListenerSource).Count) { @($ListenerSource) -join "; " } else { "no listener source" }
    if ($probed.Count) {
      [void]$warnings.Add("No listener for port $Port was listed ($src), although the API answers (seen on Windows build 26300). Localhost-only was verified instead: OLLAMA_HOST is loopback in every scope and the port refused connections on all $($probed.Count) non-loopback address(es) of this machine.")
    } else {
      [void]$warnings.Add("No listener for port $Port was listed ($src) and this machine has no non-loopback address to probe; localhost-only rests on OLLAMA_HOST (loopback in every scope).")
    }
  }
  return [pscustomobject]@{
    ok                 = ($problems.Count -eq 0)
    apiResponding      = $apiOk
    version            = $(if ($apiOk) { "$Version".Trim() } else { $null })
    listenerEnumerated = [bool]$listenerList.Count
    problems           = $problems.ToArray()
    warnings           = $warnings.ToArray()
    evidence           = [ordered]@{
      listeners       = @($listenerList | ForEach-Object { [ordered]@{ address = "$($_.address)"; pid = $_.pid; source = "$($_.source)" } })
      listenerSources = @($ListenerSource)
      ollamaHost      = $HostSetting
      probed          = $probed
      exposed         = $exposed
      apiError        = $(if ($apiOk) { $null } else { $ApiError })
    }
  }
}

# -- collectors (read-only; Windows) --

function Get-CrestmontOllamaListener([int]$Port = 11434) {
  $found = New-Object System.Collections.ArrayList
  $sources = New-Object System.Collections.ArrayList
  try {
    $rows = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($r in $rows) { [void]$found.Add([pscustomobject]@{ address = "$($r.LocalAddress)"; pid = [int]$r.OwningProcess; source = "Get-NetTCPConnection" }) }
    [void]$sources.Add("Get-NetTCPConnection: $($rows.Count)")
  } catch { [void]$sources.Add("Get-NetTCPConnection: unavailable ($($_.Exception.Message))") }
  try {
    $rows = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Port })
    foreach ($r in $rows) { [void]$found.Add([pscustomobject]@{ address = $r.Address.ToString(); pid = $null; source = "GetActiveTcpListeners" }) }
    [void]$sources.Add("GetActiveTcpListeners: $($rows.Count)")
  } catch { [void]$sources.Add("GetActiveTcpListeners: unavailable ($($_.Exception.Message))") }
  try {
    $netstat = Get-Command netstat.exe -ErrorAction SilentlyContinue
    if ($netstat) {
      $text = (& $netstat.Source -ano -p TCP | Out-String) + (& $netstat.Source -ano -p TCPv6 | Out-String)
      $rows = @(ConvertFrom-CrestmontNetstatListen -Text $text -Port $Port)
      foreach ($r in $rows) { [void]$found.Add($r) }
      [void]$sources.Add("netstat: $($rows.Count)")
    } else { [void]$sources.Add("netstat: not found") }
  } catch { [void]$sources.Add("netstat: unavailable ($($_.Exception.Message))") }
  return [pscustomobject]@{ listeners = $found.ToArray(); sources = $sources.ToArray() }
}

function Get-CrestmontNonLoopbackAddress {
  $out = New-Object System.Collections.ArrayList
  foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ("$($nic.OperationalStatus)" -ne "Up") { continue }
    foreach ($u in $nic.GetIPProperties().UnicastAddresses) {
      $s = $u.Address.ToString()
      if (-not (Test-CrestmontLoopbackAddress $s) -and -not $out.Contains($s)) { [void]$out.Add($s) }
    }
  }
  return $out.ToArray()
}

function Test-CrestmontTcpPort([string]$Address, [int]$Port, [int]$TimeoutMs = 1500) {
  $ip = [System.Net.IPAddress]::Parse($Address)
  $client = New-Object System.Net.Sockets.TcpClient($ip.AddressFamily)
  try {
    $ar = $client.BeginConnect($ip, $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($ar)
    return [bool]$client.Connected
  } catch { return $false }
  finally { $client.Close() }
}

# GET <BaseUrl><Path> as JSON, never through a proxy. Returns ok/data/error.
function Invoke-CrestmontOllamaApi([string]$Path, [string]$BaseUrl = "http://127.0.0.1:11434", [int]$TimeoutSec = 5) {
  try {
    $req = [System.Net.WebRequest]::Create("$BaseUrl$Path")
    $req.Proxy = $null
    $req.Method = "GET"
    $req.Timeout = $TimeoutSec * 1000
    $resp = $req.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $body = $reader.ReadToEnd()
    } finally { $resp.Close() }
    try { $data = $body | ConvertFrom-Json } catch { return [pscustomobject]@{ ok = $false; data = $null; error = "answered, but not with JSON (not the Ollama API?)" } }
    return [pscustomobject]@{ ok = $true; data = $data; error = $null }
  } catch { return [pscustomobject]@{ ok = $false; data = $null; error = $_.Exception.Message } }
}

# Everything above, in one call for the installer. Read-only.
function Get-CrestmontOllamaState([int]$Port = 11434) {
  $v = Invoke-CrestmontOllamaApi -Path "/api/version" -BaseUrl "http://127.0.0.1:$Port"
  $version = $null; $apiError = $v.error
  if ($v.ok) { if ($v.data -and "$($v.data.version)") { $version = "$($v.data.version)" } else { $apiError = "answered without a version field (not the Ollama API?)" } }
  $l = Get-CrestmontOllamaListener -Port $Port
  $hostSetting = @{}
  foreach ($scope in @("Process", "User", "Machine")) { $hostSetting[$scope] = "$([Environment]::GetEnvironmentVariable('OLLAMA_HOST', $scope))" }
  $probed = @(Get-CrestmontNonLoopbackAddress)
  $exposed = @($probed | Where-Object { Test-CrestmontTcpPort -Address $_ -Port $Port })
  return Resolve-CrestmontOllamaExposure -Version $version -ApiError "$apiError" -Listener @($l.listeners) -ListenerSource @($l.sources) -HostSetting $hostSetting -ProbedAddress $probed -ExposedAddress $exposed -Port $Port
}

# Exact model names Ollama has (GET /api/tags: name and model fields).
function Get-CrestmontOllamaModelName([int]$Port = 11434) {
  $t = Invoke-CrestmontOllamaApi -Path "/api/tags" -BaseUrl "http://127.0.0.1:$Port" -TimeoutSec 15
  if (-not $t.ok) { throw "GET /api/tags failed: $($t.error)" }
  return @(@($t.data.models) | ForEach-Object { "$($_.name)"; "$($_.model)" } | Where-Object { $_ } | Sort-Object -Unique)
}

# -- host.docker.internal for the egress proxy: IPv4 only (Node 1, Docker Desktop dual-stack) --
# Docker Desktop resolves host-gateway / host.docker.internal to an IPv4 AND an IPv6 address. The proxy's networks are
# IPv4-only, so Squid's CONNECT host.docker.internal:11434 went to the IPv6 address and failed with
# 503 ERR_CONNECT_FAIL 101 (network unreachable). Squid 5.7 has no dns_v4_first. The installer therefore resolves the
# host's IPv4 address that actually reaches Ollama (host-gateway-probe.cjs in a throw-away container), writes it to
# compose\.env as CRESTMONT_HOST_GATEWAY_IPV4, and docker-compose.yml pins host.docker.internal to it in the proxy's
# /etc/hosts (Squid reads hosts_file before DNS). The Squid allow-list itself is unchanged: it still matches the NAME.

# A plain dotted-quad IPv4 that may stand for the Docker host: no leading zeros, not 0.0.0.0/8, loopback, link-local,
# multicast or broadcast. Returns the address; throws otherwise (it is written into compose\.env).
function Assert-CrestmontHostGatewayIPv4([string]$Address) {
  $a = "$Address".Trim()
  if ($a -cnotmatch '^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$') {
    throw "host gateway address '$a' is not a plain IPv4 address"
  }
  $o = @($a.Split(".") | ForEach-Object { [int]$_ })
  if ($o[0] -eq 0 -or $o[0] -eq 127 -or ($o[0] -eq 169 -and $o[1] -eq 254) -or $o[0] -ge 224) {
    throw "host gateway address $a is not usable for the Docker host (0/8, loopback, link-local, multicast or reserved)"
  }
  return $a
}

# From host-gateway-probe.cjs output: the first IPv4 candidate that accepted a TCP connection. ok=$false with a
# problem text otherwise (never a guess: an unreachable or invalid address is not used).
function Select-CrestmontHostGatewayIPv4([string]$ProbeOutput, [int]$Port = 11434) {
  $line = @("$ProbeOutput" -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
  $doc = $null
  if ($line.Count) { try { $doc = $line[0] | ConvertFrom-Json } catch { $doc = $null } }
  if (-not $doc) { return [pscustomobject]@{ ok = $false; address = $null; source = $null; candidates = @(); problem = "The host-gateway probe printed no result: $("$ProbeOutput".Trim())" } }
  $cands = @($doc.candidates)
  foreach ($c in $cands) {
    if (-not $c.reachable -or -not $c.address) { continue }
    try { $ip = Assert-CrestmontHostGatewayIPv4 "$($c.address)" } catch { continue }
    return [pscustomobject]@{ ok = $true; address = $ip; source = "$($c.name)"; candidates = $cands; problem = $null }
  }
  $seen = @($cands | ForEach-Object { if ($_.address) { "$($_.name)=$($_.address) ($($_.error))" } else { "$($_.name): $($_.error)" } }) -join "; "
  return [pscustomobject]@{ ok = $false; address = $null; source = $null; candidates = $cands
    problem = "No IPv4 address of the Docker host reaches port $Port from a container ($seen). Containers must reach native Ollama over IPv4 (Docker Desktop: host.docker.internal); otherwise use -OllamaInDocker." }
}

# Addresses /etc/hosts text gives for a name (comments and other names ignored).
function Get-CrestmontHostsAddress([string]$HostsText, [string]$Name) {
  $out = New-Object System.Collections.ArrayList
  foreach ($l in ("$HostsText" -split "`r?`n")) {
    $t = @((($l -split '#', 2)[0]).Trim() -split '\s+' | Where-Object { $_ })
    if ($t.Count -lt 2) { continue }
    if (@($t[1..($t.Count - 1)]) -contains $Name) { [void]$out.Add($t[0]) }
  }
  return $out.ToArray()
}

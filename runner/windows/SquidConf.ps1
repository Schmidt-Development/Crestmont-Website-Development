<#
.SYNOPSIS
  Renders proxy\squid.conf.template into the egress allow-list (dot-sourced by Install-CrestmontRunner.ps1).

.DESCRIPTION
  Same substitution and validation as runner/windows/egress-policy.ts (renderSquidConf); the runner tests compare the
  two outputs byte for byte wherever pwsh is available (CI). Every value is checked as a host name first, so nothing
  with spaces or newlines can add Squid rules, and hosted AI API domains are refused as extras.
  Works in Windows PowerShell 5.1 and PowerShell 7. ASCII only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
#>

$script:CrestmontPaidAiDomains = @(
  ".anthropic.com", ".claude.ai", ".claude.com", ".openai.com", ".openai.azure.com", ".mistral.ai", ".googleapis.com",
  ".openrouter.ai", ".groq.com", ".together.xyz", ".together.ai", ".fireworks.ai", ".cohere.ai", ".cohere.com",
  ".deepseek.com", ".x.ai", ".perplexity.ai", ".replicate.com", "api-inference.huggingface.co", "router.huggingface.co"
)
$script:CrestmontOllamaPullDomains = @("registry.ollama.ai", ".ollama.com", ".r2.cloudflarestorage.com")

function Test-CrestmontDomainMatch {
  param([string]$Entry, [string]$HostName)
  $h = $HostName.ToLowerInvariant().TrimEnd(".")
  $e = $Entry.ToLowerInvariant()
  if ($e.StartsWith(".")) { return ($h -eq $e.Substring(1)) -or $h.EndsWith($e) }
  return $h -eq $e
}

function Test-CrestmontPaidAiHost {
  param([string]$HostName)
  foreach ($d in $script:CrestmontPaidAiDomains) { if (Test-CrestmontDomainMatch -Entry $d -HostName $HostName) { return $true } }
  return $HostName -match '^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$'
}

function Assert-CrestmontDomain {
  param([string]$Domain, [string]$Label)
  $v = "$Domain".Trim().ToLowerInvariant()
  $pattern = '^\.?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  if ($v -cnotmatch $pattern) {
    $shown = "$Domain"
    if ($shown.Length -gt 80) { $shown = $shown.Substring(0, 80) }
    throw "${Label}: `"$shown`" is not a valid host name (letters, digits, dots and hyphens only)"
  }
  $bare = $v.TrimStart(".")
  $covers = $false
  foreach ($p in $script:CrestmontPaidAiDomains) { if (Test-CrestmontDomainMatch -Entry $v -HostName $p.TrimStart(".")) { $covers = $true } }
  if ((Test-CrestmontPaidAiHost -HostName $bare) -or $covers) {
    throw "${Label}: $v is a hosted AI API (or covers one); it is always denied and cannot be allow-listed"
  }
  return $v
}

function ConvertTo-SquidConf {
  param(
    [Parameter(Mandatory = $true)][string]$Template,
    [Parameter(Mandatory = $true)][string]$PlatformHost,
    [string[]]$ExtraDomains = @(),
    [switch]$OllamaInDocker
  )
  $platform = Assert-CrestmontDomain -Domain $PlatformHost -Label "platform host"
  if ($platform.StartsWith(".")) { throw "platform host: give the exact host, not a .domain wildcard" }
  $extras = @()
  foreach ($d in @($ExtraDomains)) {
    if ("$d".Trim() -ne "") { $extras += (Assert-CrestmontDomain -Domain $d -Label "extra egress domain") }
  }
  $extra = if ($extras.Count) { $extras -join " " } else { "none.invalid" }
  $pull = if ($OllamaInDocker) { $script:CrestmontOllamaPullDomains -join " " } else { "none.invalid" }
  foreach ($p in @("__PLATFORM_HOST__", "__RUNNER_EXTRA_DOMAINS__", "__OLLAMA_PULL_DOMAINS__")) {
    if (-not $Template.Contains($p)) { throw "template is missing the $p placeholder" }
  }
  $out = $Template.Replace("__PLATFORM_HOST__", $platform).Replace("__RUNNER_EXTRA_DOMAINS__", $extra).Replace("__OLLAMA_PULL_DOMAINS__", $pull)
  $out = $out.Replace("`r`n", "`n")
  $body = ($out -split "`n" | Where-Object { -not $_.StartsWith("#") }) -join "`n"
  if ($body -cmatch '__[A-Z_]+__') { throw "unreplaced placeholder in the rendered configuration" }
  return $out
}

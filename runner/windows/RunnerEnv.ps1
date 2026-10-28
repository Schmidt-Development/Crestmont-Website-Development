<#
.SYNOPSIS
  runner.env / runner.local.env handling (dot-sourced by Install-CrestmontRunner.ps1).

.DESCRIPTION
  Same functions as runner/windows/runner-env.ts (mergeRunnerEnv); runner/test/runner-env.test.ts compares the two
  wherever pwsh is available (CI). runner.env is managed and rewritten on every run; runner.local.env holds the
  Founder's own settings and is never overwritten. Keys found in an old runner.env that the installer does not manage
  move to runner.local.env. Managed or reserved keys in runner.local.env are conflicts (the installer stops).
  Works in Windows PowerShell 5.1 and PowerShell 7. ASCII only.
#>

$script:CrestmontManagedRunnerEnvKeys = @(
  "CONTROL_PLANE_URL", "BUILD_RUNNER_SECRET_FILE", "RUNNER_ID", "RUNNER_AGENT_PROVIDER", "RUNNER_ALLOW_PAID_PROVIDER",
  "LOCAL_MODEL", "LOCAL_MODEL_BASE_URL", "LOCAL_MODEL_CONTEXT_TOKENS", "RUNNER_SANDBOX_IMAGE", "RUNNER_JOB_CPUS",
  "RUNNER_JOB_MEMORY", "RUNNER_JOB_DISK_MB", "RUNNER_SERVE_AI_DRAFTS", "LOG_LEVEL"
)
$script:CrestmontReservedLocalKeys = @(
  "RUNNER_SANDBOX", "RUNNER_JOB_UID", "RUNNER_DOCKER_BIN", "RUNNER_INSTALL_NETWORK", "RUNNER_INSTALL_PROXY", "RUNNER_NPM_REGISTRY",
  "RUNNER_ALLOWED_BUILD_SCRIPTS", "RUNNER_BROWSER_CHECK", "RUNNER_WORKSPACES", "RUNNER_SANDBOX_VOLUME",
  "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_FILE", "ANTHROPIC_BASE_URL", "RUNNER_AI_DRAFTS_PROVIDER",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"
)
$script:CrestmontRunnerEnvHeader = @(
  "# Managed by Install-CrestmontRunner.ps1 and rewritten on every run. Do not edit.",
  "# Your own settings (PROJECT_REPO_*, PREVIEW_DEPLOY_*, ...) go in runner.local.env, which the installer never overwrites."
)
$script:CrestmontLocalEnvTemplate = @(
  "# runner.local.env: your own runner settings. The installer creates this file once and never overwrites it.",
  "# Compose loads it before runner.env, so installer-managed keys cannot be changed here (the installer stops if you try).",
  "# Secrets go in files under ..\secrets\ (mounted read-only at /run/secrets); refer to them with <NAME>_FILE.",
  "#",
  "# Per-project repositories (RUNNER-SETUP.md section 4):",
  "# PROJECT_REPO_OWNER=crestmont-builds",
  "# PROJECT_REPO_OWNER_TYPE=org",
  "# PROJECT_REPO_TOKEN_FILE=/run/secrets/project_repo_token",
  "#",
  "# Preview deploys to a separate Cloudflare preview account (PREVIEW-DEPLOYMENT.md):",
  "# PREVIEW_DEPLOY_COMMAND=...",
  "# PREVIEW_DEPLOY_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID",
  "# CLOUDFLARE_API_TOKEN_FILE=/run/secrets/cloudflare_api_token",
  "# CLOUDFLARE_ACCOUNT_ID_FILE=/run/secrets/cloudflare_account_id"
)

function ConvertFrom-CrestmontEnvText {
  param([AllowNull()][string]$Text)
  $out = New-Object System.Collections.ArrayList
  if ($null -eq $Text) { return ,$out }
  $t = $Text
  if ($t.Length -gt 0 -and [int][char]$t[0] -eq 0xFEFF) { $t = $t.Substring(1) }
  foreach ($raw in ($t -split "`n")) {
    $line = $raw
    if ($line.EndsWith("`r")) { $line = $line.Substring(0, $line.Length - 1) }
    if (-not $line.Trim() -or $line -match '^\s*#') { continue }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { continue }
    $key = $line.Substring(0, $eq).Trim()
    if ($key -cnotmatch '^[A-Z_][A-Z0-9_]{0,99}$') { continue }
    [void]$out.Add([pscustomobject]@{ key = $key; value = $line.Substring($eq + 1) })
  }
  return ,$out
}

function Get-CrestmontRunnerEnvText {
  param([object[]]$Managed)
  $keys = @($Managed | ForEach-Object { $_.key })
  if (($keys -join ",") -cne ($script:CrestmontManagedRunnerEnvKeys -join ",")) { throw "managed keys must be exactly: $($script:CrestmontManagedRunnerEnvKeys -join ', ')" }
  foreach ($m in $Managed) {
    if ("$($m.value)" -cnotmatch '^[\x20-\x7e]{0,2000}$') { throw "$($m.key): value must be printable ASCII on one line" }
  }
  $lines = @($script:CrestmontRunnerEnvHeader) + @($Managed | ForEach-Object { "$($_.key)=$($_.value)" })
  return (($lines -join "`n") + "`n")
}

function Merge-CrestmontRunnerEnv {
  # The two existing-file parameters are deliberately untyped: a [string] parameter turns $null ("no file") into "".
  param([object[]]$Managed, [AllowNull()]$ExistingRunnerEnv, [AllowNull()]$ExistingLocalEnv, [string]$Stamp)
  if ($null -ne $ExistingRunnerEnv) { $ExistingRunnerEnv = [string]$ExistingRunnerEnv }
  if ($null -ne $ExistingLocalEnv) { $ExistingLocalEnv = [string]$ExistingLocalEnv }
  if ($Stamp -cnotmatch '^[0-9]{8}-[0-9]{6}$') { throw "stamp must look like 20261028-041500" }
  $runnerEnv = Get-CrestmontRunnerEnvText -Managed $Managed
  $reserved = @($script:CrestmontManagedRunnerEnvKeys) + @($script:CrestmontReservedLocalKeys)
  $oldLines = ConvertFrom-CrestmontEnvText -Text $ExistingRunnerEnv
  $local = ConvertFrom-CrestmontEnvText -Text $ExistingLocalEnv
  $localKeys = @($local | ForEach-Object { $_.key })

  $conflicts = New-Object System.Collections.ArrayList
  foreach ($l in $local) { if (($reserved -ccontains $l.key) -and -not ($conflicts -ccontains $l.key)) { [void]$conflicts.Add($l.key) } }
  $changed = New-Object System.Collections.ArrayList
  if ($null -ne $ExistingRunnerEnv) {
    foreach ($m in $Managed) {
      $old = $null
      foreach ($l in $oldLines) { if ($l.key -ceq $m.key) { $old = $l.value; break } }
      if ($old -cne $m.value) { [void]$changed.Add($m.key) }
    }
  }
  $moveLines = New-Object System.Collections.ArrayList
  $seen = New-Object System.Collections.ArrayList
  foreach ($l in $oldLines) {
    if (($script:CrestmontManagedRunnerEnvKeys -ccontains $l.key) -or ($localKeys -ccontains $l.key) -or ($seen -ccontains $l.key)) { continue }
    [void]$seen.Add($l.key)
    if ($reserved -ccontains $l.key) { if (-not ($conflicts -ccontains $l.key)) { [void]$conflicts.Add($l.key) }; continue }
    [void]$moveLines.Add($l)
  }
  $moved = @($moveLines | ForEach-Object { $_.key })

  $existing = $ExistingLocalEnv
  if ($null -ne $existing -and $existing.Length -gt 0 -and [int][char]$existing[0] -eq 0xFEFF) { $existing = $existing.Substring(1) }
  if ($null -eq $existing -or -not $existing.Trim()) { $base = ($script:CrestmontLocalEnvTemplate -join "`n") + "`n" }
  else {
    $base = $existing.Replace("`r`n", "`n")
    if (-not $base.EndsWith("`n")) { $base += "`n" }
  }
  $localEnv = $base
  if ($moveLines.Count) {
    $localEnv = $base + "# Moved from runner.env by the installer on ${Stamp}:`n" + ((@($moveLines | ForEach-Object { "$($_.key)=$($_.value)" })) -join "`n") + "`n"
  }
  return [pscustomobject]@{
    runnerEnv = $runnerEnv
    localEnv = $localEnv
    moved = @($moved)
    conflicts = @($conflicts)
    changed = @($changed)
  }
}

<#
.SYNOPSIS
  Static checks of the Windows deployment scripts (runner/windows/*.ps1). Changes nothing.

.DESCRIPTION
  1. Every script is ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI, where UTF-8 punctuation can turn
     into quote characters and break parsing.
  2. Every script parses ([System.Management.Automation.Language.Parser]::ParseFile).
  3. PSScriptAnalyzer with PSScriptAnalyzerSettings.psd1 (Windows PowerShell 5.1 syntax/command/type compatibility)
     reports no Error or Warning findings.
  Exit code 0 = all passed. Used by the CI job "windows-scripts" and runnable on any machine with pwsh.

.PARAMETER AnalyzerPath
  Path to a PSScriptAnalyzer module manifest. Default: the installed module (installed from the PowerShell Gallery,
  version 1.24.0, when missing and -InstallAnalyzer is given).
#>
[CmdletBinding()]
param(
  [string]$AnalyzerPath = "",
  [switch]$InstallAnalyzer,
  [switch]$SkipAnalyzer
)
$ErrorActionPreference = "Stop"
$failures = 0
$scripts = @(Get-ChildItem -Path $PSScriptRoot -Filter *.ps1 | Sort-Object Name)

foreach ($f in $scripts) {
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $nonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count
  if ($nonAscii) { Write-Output ("FAIL ascii  {0}: {1} non-ASCII bytes" -f $f.Name, $nonAscii); $failures++ }
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
  if ($errors.Count) {
    foreach ($e in $errors) { Write-Output ("FAIL parse  {0}:{1} {2}" -f $f.Name, $e.Extent.StartLineNumber, $e.Message) }
    $failures++
  } else { Write-Output ("OK   parse  {0}" -f $f.Name) }
}

if (-not $SkipAnalyzer) {
  if ($AnalyzerPath) { Import-Module $AnalyzerPath }
  else {
    if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer) -and $InstallAnalyzer) {
      Install-Module -Name PSScriptAnalyzer -RequiredVersion 1.24.0 -Scope CurrentUser -Force
    }
    Import-Module PSScriptAnalyzer
  }
  Write-Output ("PSScriptAnalyzer {0}, PowerShell {1}" -f (Get-Module PSScriptAnalyzer).Version, $PSVersionTable.PSVersion)
  $settings = Join-Path $PSScriptRoot "PSScriptAnalyzerSettings.psd1"
  $findings = @(Invoke-ScriptAnalyzer -Path $PSScriptRoot -Settings $settings)
  foreach ($x in $findings) { Write-Output ("FAIL pssa   {0}:{1} [{2}] {3}: {4}" -f $x.ScriptName, $x.Line, $x.Severity, $x.RuleName, $x.Message) }
  if ($findings.Count) { $failures++ } else { Write-Output "OK   pssa   no Error/Warning findings in $($scripts.Count) scripts" }
}

if ($failures) { Write-Output "FAILED ($failures)"; exit 1 }
Write-Output "PASSED"
exit 0

<#
.SYNOPSIS
  Installs the Crestmont file scanner (ClamAV + scanner/) on Node 1 as its own Docker Compose project.

.DESCRIPTION
  Safe to re-run; nothing is started unless -Install is given. Steps:
    1. Prerequisites: Docker Desktop answering (docker compose v2).
    2. -InstallDir with a restrictive ACL (SYSTEM, Administrators, this user), and a copy of scanner\.
    3. scanner.env: PLATFORM_URL, SCANNER_ID and FILE_SCANNER_SECRET. The secret is read with hidden input (or from
       -SecretFile), never printed, never on a command line, and written only to scanner.env under that ACL.
       An existing scanner.env keeps its secret unless -ReplaceSecret is given.
    4. docker compose up -d --build for the project "crestmont-scanner" ONLY. It does not touch, stop or restart the
       build runner ("crestmont-runner"), the research worker, or anything else on this machine.
    5. Preflight: waits for clamd to load its signatures, then "node src/main.ts --preflight" inside the scanner
       container (clamd answers; the platform accepts the signed heartbeat).
  It opens NO inbound port: nothing is published, and the scanner's health endpoint listens on 127.0.0.1 inside
  its own container.

.PARAMETER PlatformUrl
  https origin of the platform. Use STAGING first; production only after the Founder's approval.

.EXAMPLE
  .\scanner\windows\Install-CrestmontScanner.ps1 -PlatformUrl https://crestmont-platform-staging.example.workers.dev -Install
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PlatformUrl,
  [string]$InstallDir = "C:\CrestmontScanner",
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$ScannerId = "node1-clamav",
  [string]$SecretFile = "",
  [switch]$ReplaceSecret,
  [switch]$Install
)
$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  XX  $m" -ForegroundColor Red; exit 1 }

if ($PlatformUrl -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?$') { Fail "PlatformUrl must be an https origin without a path" }
if ($ScannerId -notmatch '^[a-z0-9][a-z0-9-]{0,39}$') { Fail "ScannerId must be 1-40 characters of a-z, 0-9 and '-'" }

Step "Prerequisites"
& docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "docker compose is not available (start Docker Desktop)" }
Ok "docker compose available"

Step "Folder and copy ($InstallDir)"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
& icacls.exe $InstallDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "icacls on $InstallDir failed" }
$src = Join-Path $RepoPath "scanner"
foreach ($item in @("src", "package.json", "Dockerfile", "docker-compose.yml")) {
  Copy-Item -Recurse -Force (Join-Path $src $item) $InstallDir
}
Ok "scanner copied (Node standard library only; nothing to install)"

Step "scanner.env"
$envPath = Join-Path $InstallDir "scanner.env"
$existing = @{}
if (Test-Path $envPath) {
  foreach ($line in Get-Content $envPath) { if ($line -match '^([A-Z_]+)=(.*)$') { $existing[$Matches[1]] = $Matches[2] } }
}
$secret = $existing["FILE_SCANNER_SECRET"]
if (-not $secret -or $ReplaceSecret) {
  if ($SecretFile) { $secret = (Get-Content $SecretFile -Raw).Trim() }
  else {
    $sec = Read-Host -AsSecureString "Paste FILE_SCANNER_SECRET (the same value as the platform's Worker secret; input hidden)"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
}
if (-not $secret -or $secret.Length -lt 32) { Fail "FILE_SCANNER_SECRET looks too short (< 32 characters)." }
if ($secret -match '[\r\n]') { Fail "FILE_SCANNER_SECRET must be a single line." }
$content = "PLATFORM_URL=$PlatformUrl`nSCANNER_ID=$ScannerId`nFILE_SCANNER_SECRET=$secret`n"
[IO.File]::WriteAllText($envPath, $content)   # no BOM
$secret = $null
$content = $null
Ok "scanner.env written (secret not displayed)"

if (-not $Install) { Warn "Dry run: nothing started. Re-run with -Install to build and start the scanner."; exit 0 }

Step "Start (project crestmont-scanner only)"
Push-Location $InstallDir
try {
  & docker compose -p crestmont-scanner -f docker-compose.yml up -d --build
  if ($LASTEXITCODE -ne 0) { Fail "docker compose up failed" }
  Ok "containers started"

  Step "Preflight"
  $deadline = (Get-Date).AddMinutes(10)
  do {
    Start-Sleep -Seconds 15
    & docker compose -p crestmont-scanner exec -T scanner node --no-warnings src/main.ts --preflight
    $code = $LASTEXITCODE
  } while ($code -ne 0 -and (Get-Date) -lt $deadline)
  if ($code -ne 0) { Fail "preflight did not pass within 10 minutes (clamd still loading signatures, or the platform refused the secret: see 'docker compose -p crestmont-scanner logs')" }
  Ok "clamd answers and the platform accepted the signed heartbeat"
} finally { Pop-Location }
Write-Host "`nScanner running. Health: Owner > Readiness (feed malware-scan). Logs: docker compose -p crestmont-scanner logs -f"

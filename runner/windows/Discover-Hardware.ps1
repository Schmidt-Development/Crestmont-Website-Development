<#
.SYNOPSIS
  READ-ONLY hardware and prerequisite discovery for the Crestmont self-hosted build runner.

.DESCRIPTION
  Prints one JSON document (schema "crestmont.hardware/1", documented in docs/ai-builds/WINDOWS-SUPERCOMPUTER.md) with:
  CPU, RAM, GPUs (nvidia-smi when present, else Win32_VideoController), free disk per drive, Windows edition/build,
  virtualization + WSL status, Docker Desktop, Ollama, reachability of the platform URL and registry.npmjs.org
  (HEAD requests), and a CPU/RAM/GPU utilization snapshot.
  It changes nothing, installs nothing, reads no secrets and sends nothing anywhere except the two HEAD requests.
  Works in Windows PowerShell 5.1 and PowerShell 7. Administrator rights are not required (a few virtualization
  fields may be null without them).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Discover-Hardware.ps1 -PlatformUrl https://crestmont.example | Out-File -Encoding utf8 hardware.json
#>
[CmdletBinding()]
param(
  [string]$PlatformUrl = "",
  [string]$OllamaUrl = "http://127.0.0.1:11434",
  [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"
$warnings = New-Object System.Collections.ArrayList

function Add-Warning([string]$Text) { [void]$warnings.Add($Text) }

function Invoke-Safely([scriptblock]$Block, $Default = $null) {
  try { return & $Block } catch { return $Default }
}

function Round1($Value) { if ($null -eq $Value) { return $null }; return [math]::Round([double]$Value, 1) }

function Get-Vendor([string]$Name) {
  if ($Name -match "NVIDIA|GeForce|Quadro|Tesla|RTX") { return "nvidia" }
  if ($Name -match "AMD|Radeon|ATI") { return "amd" }
  if ($Name -match "Intel") { return "intel" }
  return "other"
}

function Test-Url([string]$Url) {
  if (-not $Url) { return $null }
  try {
    $req = [System.Net.WebRequest]::Create($Url)
    $req.Method = "HEAD"
    $req.Timeout = $TimeoutSeconds * 1000
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return @{ reachable = $true; status = $code }
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) { return @{ reachable = $true; status = [int]$_.Exception.Response.StatusCode } }
    return @{ reachable = $false; status = $null; error = $_.Exception.Message }
  } catch {
    return @{ reachable = $false; status = $null; error = $_.Exception.Message }
  }
}

# -- OS --
$os = Invoke-Safely { Get-CimInstance Win32_OperatingSystem }
$osInfo = [ordered]@{
  caption = if ($os) { $os.Caption } else { $null }
  version = if ($os) { $os.Version } else { $null }
  build = if ($os) { [int]$os.BuildNumber } else { $null }
  architecture = if ($os) { $os.OSArchitecture } else { $null }
  edition = Invoke-Safely { (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").EditionID }
  displayVersion = Invoke-Safely { (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").DisplayVersion }
}

# -- CPU --
$cpus = @(Invoke-Safely { Get-CimInstance Win32_Processor } @())
$cpuInfo = [ordered]@{
  name = if ($cpus.Count) { ($cpus[0].Name).Trim() } else { $null }
  sockets = $cpus.Count
  cores = [int](($cpus | Measure-Object -Property NumberOfCores -Sum).Sum)
  logicalProcessors = [int](($cpus | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
  maxClockMHz = if ($cpus.Count) { [int]$cpus[0].MaxClockSpeed } else { $null }
  virtualizationFirmwareEnabled = if ($cpus.Count) { $cpus[0].VirtualizationFirmwareEnabled } else { $null }
  loadPercent = Round1 (($cpus | Measure-Object -Property LoadPercentage -Average).Average)
}

# -- Memory --
$cs = Invoke-Safely { Get-CimInstance Win32_ComputerSystem }
$memInfo = [ordered]@{
  totalGB = if ($cs) { Round1 ($cs.TotalPhysicalMemory / 1GB) } else { $null }
  freeGB = if ($os) { Round1 ($os.FreePhysicalMemory * 1KB / 1GB) } else { $null }
  usedPercent = if ($os) { Round1 (100 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize * 100)) } else { $null }
}

# -- GPUs --
$gpus = New-Object System.Collections.ArrayList
$nvsmi = Invoke-Safely { (Get-Command nvidia-smi -ErrorAction Stop).Source }
if (-not $nvsmi -and (Test-Path "$env:SystemRoot\System32\nvidia-smi.exe")) { $nvsmi = "$env:SystemRoot\System32\nvidia-smi.exe" }
if ($nvsmi) {
  $lines = Invoke-Safely { & $nvsmi --query-gpu=name,memory.total,driver_version,utilization.gpu,memory.used --format=csv,noheader,nounits } @()
  foreach ($line in @($lines)) {
    $p = $line -split ",\s*"
    if ($p.Count -ge 5) {
      [void]$gpus.Add([ordered]@{
        name = $p[0].Trim(); vendor = "nvidia"; vramGB = Round1 ([double]$p[1] / 1024); vramReliable = $true
        driverVersion = $p[2].Trim(); source = "nvidia-smi"; utilizationPercent = [double]$p[3]; memoryUsedGB = Round1 ([double]$p[4] / 1024)
      })
    }
  }
}
$controllers = @(Invoke-Safely { Get-CimInstance Win32_VideoController } @())
foreach ($c in $controllers) {
  $vendor = Get-Vendor $c.Name
  if ($vendor -eq "nvidia" -and $gpus.Count -gt 0) { continue }   # already reported by nvidia-smi
  $vram = $null
  $reliable = $false
  # AdapterRAM is a 32-bit field (caps near 4 GB); the registry qwMemorySize is 64-bit when the driver sets it.
  $qw = Invoke-Safely {
    $key = Get-ChildItem "HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction Stop |
      Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DriverDesc -eq $c.Name } | Select-Object -First 1
    if ($key) { (Get-ItemProperty $key.PSPath -ErrorAction Stop)."HardwareInformation.qwMemorySize" } else { $null }
  }
  if ($qw) { $vram = Round1 ([double]$qw / 1GB); $reliable = $true }
  elseif ($c.AdapterRAM) { $vram = Round1 ([double]$c.AdapterRAM / 1GB) }
  [void]$gpus.Add([ordered]@{
    name = $c.Name; vendor = $vendor; vramGB = $vram; vramReliable = $reliable; driverVersion = $c.DriverVersion
    source = if ($reliable) { "registry qwMemorySize" } else { "Win32_VideoController" }; utilizationPercent = $null; memoryUsedGB = $null
  })
}
if ($gpus.Count -eq 0) { Add-Warning "No GPU detected." }

# -- Disks --
$disks = New-Object System.Collections.ArrayList
foreach ($d in @(Invoke-Safely { Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" } @())) {
  [void]$disks.Add([ordered]@{ drive = $d.DeviceID; freeGB = Round1 ($d.FreeSpace / 1GB); totalGB = Round1 ($d.Size / 1GB); fileSystem = $d.FileSystem })
}

# -- Virtualization / WSL --
$wslExe = Invoke-Safely { (Get-Command wsl.exe -ErrorAction Stop).Source }
$wslStatusRaw = $null
$wslVersion2 = $null
if ($wslExe) {
  # wsl.exe writes UTF-16; read it as text and strip NULs.
  $wslStatusRaw = Invoke-Safely { ((& $wslExe --status 2>&1) | Out-String) -replace "`0", "" }
  if ($wslStatusRaw -match "Default Version:\s*2" -or $wslStatusRaw -match "Standardversion:\s*2") { $wslVersion2 = $true }
  elseif ($wslStatusRaw -match "Default Version:\s*1") { $wslVersion2 = $false }
}
$virtInfo = [ordered]@{
  hypervisorPresent = if ($cs) { $cs.HypervisorPresent } else { $null }
  firmwareEnabled = $cpuInfo.virtualizationFirmwareEnabled
  wslInstalled = [bool]$wslExe
  wslVersion2 = $wslVersion2
  wslStatusRaw = if ($wslStatusRaw) { $wslStatusRaw.Trim().Substring(0, [math]::Min(1500, $wslStatusRaw.Trim().Length)) } else { $null }
}

# -- Docker Desktop --
$dockerExe = Invoke-Safely { (Get-Command docker.exe -ErrorAction Stop).Source }
$dockerInfo = [ordered]@{ installed = [bool]$dockerExe; clientVersion = $null; serverVersion = $null; serverReachable = $false; desktopInstalled = (Test-Path "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe") }
if ($dockerExe) {
  $dockerInfo.clientVersion = Invoke-Safely { (& $dockerExe version --format "{{.Client.Version}}" 2>$null | Out-String).Trim() }
  $sv = Invoke-Safely { (& $dockerExe version --format "{{.Server.Version}}" 2>$null | Out-String).Trim() }
  if ($sv -and $LASTEXITCODE -eq 0) { $dockerInfo.serverVersion = $sv; $dockerInfo.serverReachable = $true }
}

# -- Ollama --
$ollamaExe = Invoke-Safely { (Get-Command ollama.exe -ErrorAction Stop).Source }
if (-not $ollamaExe -and (Test-Path "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")) { $ollamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" }
$ollamaInfo = [ordered]@{ installed = [bool]$ollamaExe; version = $null; listening = $false; models = @(); hostSetting = [Environment]::GetEnvironmentVariable("OLLAMA_HOST", "User") }
if ($ollamaExe) { $ollamaInfo.version = Invoke-Safely { ((& $ollamaExe --version 2>&1) | Out-String).Trim() } }
$tags = Invoke-Safely { Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -TimeoutSec $TimeoutSeconds }
if ($tags) { $ollamaInfo.listening = $true; $ollamaInfo.models = @($tags.models | ForEach-Object { $_.name }) }

# -- Network (outbound HEAD only) --
$netInfo = [ordered]@{
  platformUrl = if ($PlatformUrl) { $PlatformUrl } else { $null }
  platform = Test-Url $PlatformUrl
  npmRegistry = Test-Url "https://registry.npmjs.org/"
}
if (-not $PlatformUrl) { Add-Warning "No -PlatformUrl given: platform reachability not tested." }

$result = [ordered]@{
  schema = "crestmont.hardware/1"
  collectedAt = (Get-Date).ToUniversalTime().ToString("o")
  computer = [ordered]@{ manufacturer = if ($cs) { $cs.Manufacturer } else { $null }; model = if ($cs) { $cs.Model } else { $null } }
  os = $osInfo
  cpu = $cpuInfo
  memory = $memInfo
  gpus = @($gpus)
  disks = @($disks)
  virtualization = $virtInfo
  docker = $dockerInfo
  ollama = $ollamaInfo
  network = $netInfo
  warnings = @($warnings)
}

$result | ConvertTo-Json -Depth 6

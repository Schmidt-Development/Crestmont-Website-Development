# PSScriptAnalyzer settings for runner/windows/*.ps1 (used by Test-WindowsScripts.ps1 locally and in CI).
# Target: Windows PowerShell 5.1 on the build machine (PowerShell 7 also works).
@{
  Severity     = @('Error', 'Warning')
  ExcludeRules = @(
    # Interactive operator scripts: coloured console output for a person, not pipeline output.
    'PSAvoidUsingWriteHost',
    # Discover-Hardware.ps1 uses script parameters inside scriptblocks/functions; the rule reports them as unused.
    'PSReviewUnusedParameter'
  )
  Rules        = @{
    PSUseCompatibleSyntax   = @{
      Enable         = $true
      TargetVersions = @('5.1', '7.0')
    }
    PSUseCompatibleCommands = @{
      Enable         = $true
      # Windows Server 2019 / Windows PowerShell 5.1 profile shipped with PSScriptAnalyzer.
      TargetProfiles = @('win-48_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework')
    }
    PSUseCompatibleTypes    = @{
      Enable         = $true
      TargetProfiles = @('win-48_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework')
    }
  }
}

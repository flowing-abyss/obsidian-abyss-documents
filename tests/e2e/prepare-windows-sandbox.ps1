param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$packageGroups = @('S-1-15-2-1', 'S-1-15-2-2')
$readExecute = [long][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
$result = [ordered]@{ status = 'skipped'; before = @(); after = @() }
$failed = $false

function Read-SandboxAcl([string]$ItemPath) {
    $acl = Get-Acl -LiteralPath $ItemPath
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $specificPackage = @($rules | Where-Object {
        $_.IdentityReference.Value.StartsWith('S-1-15-2-') -and
        $_.IdentityReference.Value -notin $packageGroups
    }).Count -gt 0
    $allowRx = $false
    foreach ($sid in $packageGroups) {
        $rights = [long]0
        foreach ($rule in $rules) {
            if ($rule.IdentityReference.Value -eq $sid -and
                $rule.AccessControlType -eq 'Allow' -and
                -not ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) {
                $rights = $rights -bor [long]$rule.FileSystemRights
            }
        }
        if (($rights -band $readExecute) -eq $readExecute) { $allowRx = $true }
    }
    $deny = @($rules | Where-Object {
        $_.AccessControlType -eq 'Deny' -and
        ($_.IdentityReference.Value -in ($packageGroups + 'S-1-1-0')) -and
        -not ($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -and
        ([long]$_.FileSystemRights -band $readExecute)
    }).Count -gt 0
    return [ordered]@{
        path = $ItemPath; sddl = $acl.Sddl
        specificPackage = $specificPackage; allowReadExecute = $allowRx; conflictingDeny = $deny
        rules = @($rules | ForEach-Object { [ordered]@{
            sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType
            rights = [long]$_.FileSystemRights; inherited = $_.IsInherited
            inheritance = [string]$_.InheritanceFlags; propagation = [string]$_.PropagationFlags
        } })
    }
}

try {
    $workspace = (Get-Item -LiteralPath $RepoRoot).FullName
    $cache = [System.IO.Path]::GetFullPath((Join-Path $workspace '.obsidian-cache/obsidian-installer'))
    $directory = (Get-Item -LiteralPath $Installer).Directory.FullName
    if (-not $directory.StartsWith($cache + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        $result.status = 'custom-binary-skipped'
    } else {
        $ancestors = @()
        for ($item = Get-Item -LiteralPath $directory; $null -ne $item -and $item.FullName.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase); $item = $item.Parent) {
            $ancestors += $item
        }
        $reparse = @(@($ancestors) + @(Get-ChildItem -LiteralPath $directory -Recurse -Force) | Where-Object {
            $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
        })
        if ($reparse.Count -gt 0) {
            $result.status = 'reparse-point-skipped'
        } else {
            $paths = @($directory, (Join-Path $directory 'icudtl.dat'))
            $result.before = @($paths | ForEach-Object { Read-SandboxAcl $_ })
            $matchedStates = @($result.before | Where-Object { $_.specificPackage -and -not $_.allowReadExecute })
            if (@($result.before | Where-Object { $_.conflictingDeny }).Count -gt 0) {
                $result.status = 'conflicting-deny-skipped'
            } elseif ($matchedStates.Count -gt 0) {
                # Electron's documented installer ACL pattern; keep its sandbox enabled.
                # https://github.com/electron/electron/pull/54382
                $result.status = 'matched-pattern'
                $result.icaclsOutput = @(& icacls.exe $directory '/grant' '*S-1-15-2-1:(OI)(CI)(RX)' '/T' '/C')
                $result.icaclsExitCode = $LASTEXITCODE
                if ($LASTEXITCODE -ne 0) { throw 'icacls did not grant all requested cache permissions.' }
                $result.status = 'grant-applied'
                $result.after = @($paths | ForEach-Object { Read-SandboxAcl $_ })
            } else {
                $result.status = 'pattern-absent'
            }
        }
    }
} catch {
    $failed = $true
    $result.error = $_.Exception.Message
} finally {
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}
if ($failed) { exit 1 }

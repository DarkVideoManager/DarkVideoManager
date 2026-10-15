[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ChecksumFile,
    [switch]$AsJson
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    try { $target = Get-Item -LiteralPath $FilePath -Force } catch {
        throw 'Downloaded file not found or inaccessible. Check FilePath.'
    }
    try { $manifest = Get-Item -LiteralPath $ChecksumFile -Force } catch {
        throw 'Checksum file not found or inaccessible. Check ChecksumFile and download SHA256SUMS.txt from the same official release.'
    }
    if ($target -isnot [System.IO.FileInfo]) { throw 'FilePath must name a downloaded file.' }
    if ($manifest -isnot [System.IO.FileInfo]) { throw 'ChecksumFile must name SHA256SUMS.txt from the same official release.' }

    $entries = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    $contents = [System.IO.File]::ReadAllText($manifest.FullName, [System.Text.Encoding]::UTF8)
    foreach ($line in ($contents -split "`r?`n")) {
        if ($line.Length -eq 0) { continue }
        if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
            throw 'Malformed checksum entry. Expected a SHA-256 hash, two spaces, and a file name.'
        }
        $expectedHash = $Matches[1].ToLowerInvariant()
        $name = $Matches[2]
        if ($name -match '[<>:"/\\|?*\x00-\x1f\x7f]' -or
            $name -eq '.' -or $name -eq '..' -or
            $name -ne $name.Trim() -or $name.EndsWith('.')) {
            throw 'Checksum entries must contain an unambiguous file name without directories or control characters.'
        }
        if ($entries.ContainsKey($name)) { throw "Duplicate checksum file name: $name" }
        $entries.Add($name, $expectedHash)
    }
    if ($entries.Count -eq 0) { throw 'The checksum file contains no file entries.' }
    if (-not $entries.ContainsKey($target.Name)) {
        throw 'The selected file name is absent from SHA256SUMS.txt. Use the original download name and the checksum file from the same release.'
    }

    $actualHash = (Get-FileHash -LiteralPath $target.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $signatureStatus = 'Unavailable'
    $signerSubject = $null
    if (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue) {
        try {
            $signature = Get-AuthenticodeSignature -LiteralPath $target.FullName
            $signatureStatus = $signature.Status.ToString()
            if ($null -ne $signature.SignerCertificate) { $signerSubject = $signature.SignerCertificate.Subject }
        } catch {
            $signatureStatus = 'InspectionFailed'
        }
    }
    $result = [pscustomobject]@{
        FileName = $target.Name
        ExpectedSha256 = $entries[$target.Name]
        ActualSha256 = $actualHash
        HashMatches = $actualHash -eq $entries[$target.Name]
        SignatureStatus = $signatureStatus
        SignerSubject = $signerSubject
    }
    if ($AsJson) { $result | ConvertTo-Json -Compress } else { $result }
    if (-not $result.HashMatches) {
        throw 'SHA-256 mismatch. Do not run this file; download the file and SHA256SUMS.txt again from the same official release.'
    }
} catch {
    Write-Error -Message ("Release verification failed: {0}" -f $_.Exception.Message) -ErrorAction Continue
    exit 1
}

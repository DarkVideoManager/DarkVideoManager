/** PS5.1's default Get-Content code page is not the encoding of redirected WSL output. */
export const subtitleInstallOutputReader = String.raw`
function Read-InstallOutput([string]$path) {
  if (!(Test-Path -LiteralPath $path)) { return '' }
  $stream=$null
  try {
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    $header=New-Object byte[] 3
    $headerSize=$stream.Read($header,0,3)
    $offset=[Math]::Max(0,$stream.Length-16384)
    if ($offset % 2) { $offset-- }
    $null=$stream.Seek($offset,[IO.SeekOrigin]::Begin)
    $bytes=New-Object byte[] ([Math]::Min(16386,$stream.Length-$offset))
    $count=$stream.Read($bytes,0,$bytes.Length)
    $encoding=$null
    if ($headerSize -ge 2 -and $header[0] -eq 255 -and $header[1] -eq 254) { $encoding=[Text.Encoding]::Unicode }
    elseif ($headerSize -ge 2 -and $header[0] -eq 254 -and $header[1] -eq 255) { $encoding=[Text.Encoding]::BigEndianUnicode }
    else {
      $zeros=0
      for ($i=1; $i -lt [Math]::Min($count,256); $i+=2) { if ($bytes[$i] -eq 0) { $zeros++ } }
      if ($zeros -ge 4) { $encoding=[Text.Encoding]::Unicode }
    }
    if ($null -ne $encoding) { $text=$encoding.GetString($bytes,0,$count) }
    else {
      $utf8=[Text.UTF8Encoding]::new($false,$true)
      $text=$null
      # A bounded tail can start inside a UTF-8 character.
      for ($skip=0; $skip -le [Math]::Min(3,$count); $skip++) {
        try { $text=$utf8.GetString($bytes,$skip,$count-$skip); break } catch {}
      }
      if ($null -eq $text) { $text=[Text.Encoding]::Default.GetString($bytes,0,$count) }
    }
    $text=$text.Trim([char]0xFEFF).Replace([string][char]0,'')
    $text=[regex]::Replace($text,'(?i)(?:[a-z]:[\\/]|\\\\)[^\r\n"<>|]*','[local path]')
    $text=[regex]::Replace($text,'(?i)\b(?:Bearer\s+\S+|(?:api[-_]?key|token|password|secret)\s*[:=]\s*\S+)','[secret hidden]')
    if ($text.Length -gt 1800) { $text=$text.Substring($text.Length-1800) }
    return $text
  } catch { return '' }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
}
`

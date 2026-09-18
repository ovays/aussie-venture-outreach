param([string]$EnvironmentFile = '.env.v2.local')

$ErrorActionPreference = 'Stop'
$target = (Resolve-Path -LiteralPath $EnvironmentFile).Path
$resolvedTarget = [IO.Path]::GetFullPath($target)
$workspace = [IO.Path]::GetFullPath((Get-Location).Path) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedTarget.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to repair an environment file outside the workspace.'
}

$lines = [Collections.Generic.List[string]]::new()
$seenKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$reader = [IO.StreamReader]::new($resolvedTarget, [Text.Encoding]::UTF8, $true, 4096)
try {
  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($line.Length -gt 65536) { break }
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=') {
      $key = $Matches[1]
      if ($seenKeys.Contains($key)) { break }
      [void]$seenKeys.Add($key)
    }
    [void]$lines.Add($line)
    if ($lines.Count -gt 10000) { throw 'The first environment block is unexpectedly large.' }
  }
} finally {
  $reader.Dispose()
}

function Set-Value([string]$Name, [string]$Value) {
  $found = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match "^$([regex]::Escape($Name))=") {
      $lines[$index] = "$Name=$Value"
      $found = $true
      break
    }
  }
  if (-not $found) { [void]$lines.Add("$Name=$Value") }
}

foreach ($name in @(
  'V2_SHADOW_SUPABASE_URL', 'V2_SHADOW_SUPABASE_READ_KEY',
  'V2_SHADOW_SUPABASE_PUBLISHABLE_KEY', 'V2_SHADOW_SUPABASE_ACCESS_TOKEN',
  'V2_SHADOW_SUPABASE_SCHEMA'
)) { Set-Value $name '' }
Set-Value 'V2_SHADOW_ALLOW_PRODUCTION_READS' 'false'

$temporary = "$resolvedTarget.prompt15-repair"
[IO.File]::WriteAllLines($temporary, $lines.ToArray(), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $resolvedTarget -Force

[ordered]@{
  status = 'REPAIRED'
  preservedFirstEnvironmentBlock = $true
  lineCount = $lines.Count
  productionShadowCredentialsCleared = $true
  productionReadsDisabled = $true
  repairedBytes = (Get-Item -LiteralPath $resolvedTarget).Length
} | ConvertTo-Json

param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9]{20}$')]
  [string]$ProjectRef,

  [ValidateSet('Provision', 'Rollback')]
  [string]$Mode = 'Provision',

  [string]$EnvironmentFile = '.env.v2.local'
)

$ErrorActionPreference = 'Stop'
$shadowRole = 'reachagent_prompt15_shadow_reader'
$shadowSchema = 'reachagent_prompt15_shadow'
$keyName = 'reachagent_prompt15_shadow_reader'
$projectUrl = "https://$ProjectRef.supabase.co"
$applySqlPath = Join-Path $PSScriptRoot 'prompt15-shadow-reader-production.sql'
$rollbackSqlPath = Join-Path $PSScriptRoot 'prompt15-shadow-reader-production-rollback.sql'

if (-not ('Prompt15.ProvisionCredential' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace Prompt15 {
  public static class ProvisionCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
      public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
      public uint Persist; public uint AttributeCount; public IntPtr Attributes;
      public IntPtr TargetAlias; public IntPtr UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern void CredFree(IntPtr credential);
    public static string ReadGeneric(string target) {
      IntPtr pointer;
      if (!CredRead(target, 1, 0, out pointer)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
        byte[] buffer = new byte[credential.CredentialBlobSize];
        Marshal.Copy(credential.CredentialBlob, buffer, 0, buffer.Length);
        return Encoding.UTF8.GetString(buffer).TrimEnd('\0');
      } finally { CredFree(pointer); }
    }
  }
}
'@
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-ShadowJwt([string]$Secret) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $headerJson = @{ alg = 'HS256'; typ = 'JWT' } | ConvertTo-Json -Compress
  $payloadJson = @{
    role = $shadowRole
    iat = $now
    exp = $now + 3600
    jti = [Guid]::NewGuid().ToString()
  } | ConvertTo-Json -Compress
  $header = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($headerJson))
  $payload = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($payloadJson))
  $unsigned = "$header.$payload"
  $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
  try { $signature = ConvertTo-Base64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($unsigned))) }
  finally { $hmac.Dispose() }
  return "$unsigned.$signature"
}

function Set-LocalEnvironmentValue([string]$Path, [string]$Name, [string]$Value) {
  $resolved = if ([IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path (Get-Location) $Path }
  $lines = [Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $resolved) {
    foreach ($line in Get-Content -LiteralPath $resolved) { $lines.Add([string]$line) }
  }
  $match = -1
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match "^$([regex]::Escape($Name))=") { $match = $index; break }
  }
  $entry = "$Name=$Value"
  if ($match -ge 0) { $lines[$match] = $entry } else { $lines.Add($entry) }
  [IO.File]::WriteAllLines($resolved, $lines, [Text.UTF8Encoding]::new($false))
}

$managementToken = [Prompt15.ProvisionCredential]::ReadGeneric('Supabase CLI:supabase')
$headers = @{ Authorization = "Bearer $managementToken" }
$baseUri = "https://api.supabase.com/v1/projects/$ProjectRef"

function Invoke-DatabaseSql([string]$Path) {
  $sql = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path).Path)
  $body = @{ query = $sql } | ConvertTo-Json -Compress
  $null = Invoke-RestMethod -Method Post -Uri "$baseUri/database/query" -Headers $headers -ContentType 'application/json' -Body $body
}

function Set-DataApiSchemas([string]$Schemas) {
  $body = @{ db_schema = $Schemas } | ConvertTo-Json -Compress
  $null = Invoke-RestMethod -Method Patch -Uri "$baseUri/postgrest" -Headers $headers -ContentType 'application/json' -Body $body
}

function Clear-LocalShadowCredentials {
  foreach ($name in @(
    'V2_SHADOW_SUPABASE_URL', 'V2_SHADOW_SUPABASE_READ_KEY',
    'V2_SHADOW_SUPABASE_PUBLISHABLE_KEY', 'V2_SHADOW_SUPABASE_ACCESS_TOKEN',
    'V2_SHADOW_SUPABASE_SCHEMA'
  )) { Set-LocalEnvironmentValue $EnvironmentFile $name '' }
  Set-LocalEnvironmentValue $EnvironmentFile 'V2_SHADOW_ALLOW_PRODUCTION_READS' 'false'
}

try {
  $postgrest = Invoke-RestMethod -Method Get -Uri "$baseUri/postgrest" -Headers $headers
  $originalSchemas = @($postgrest.db_schema -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $keys = Invoke-RestMethod -Method Get -Uri "$baseUri/api-keys" -Headers $headers
  $dedicatedKeys = @($keys | Where-Object { $_.type -eq 'publishable' -and $_.name -eq $keyName })

  if ($Mode -eq 'Rollback') {
    if ($originalSchemas -contains $shadowSchema) {
      Set-DataApiSchemas (($originalSchemas | Where-Object { $_ -ne $shadowSchema }) -join ',')
    }
    Invoke-DatabaseSql $rollbackSqlPath
    foreach ($key in $dedicatedKeys) {
      $keyId = ([Guid]([string]$key.id)).ToString('D')
      $deleteUri = [Uri]::new("$baseUri/api-keys/$keyId")
      $null = Invoke-RestMethod -Method Delete -Uri $deleteUri.AbsoluteUri -Headers $headers
    }
    Clear-LocalShadowCredentials
    [ordered]@{ status = 'ROLLED_BACK'; dataApiSchemaRemoved = $true; readerRoleDropped = $true; viewOwnerRoleDropped = $true; dedicatedPublishableKeysRevoked = $dedicatedKeys.Count; localCredentialsCleared = $true } | ConvertTo-Json
    exit 0
  }

  if ($originalSchemas -contains $shadowSchema) { throw 'Prompt 15 shadow schema is already exposed.' }
  if ($dedicatedKeys.Count -ne 0) { throw 'A dedicated Prompt 15 publishable key already exists.' }
  if ([string]::IsNullOrWhiteSpace([string]$postgrest.jwt_secret)) {
    throw 'USER ACTION REQUIRED - JWT ISSUANCE BLOCKED: existing trusted JWT signing material is unavailable.'
  }

  $sqlApplied = $false
  $schemaExposed = $false
  $createdKey = $null
  try {
    Invoke-DatabaseSql $applySqlPath
    $sqlApplied = $true
    Set-DataApiSchemas ((@($originalSchemas) + $shadowSchema) -join ',')
    $schemaExposed = $true
    $keyBody = @{
      type = 'publishable'
      name = $keyName
      description = 'Dedicated Prompt 15 production shadow-reader API key'
    } | ConvertTo-Json -Compress
    $createdKey = Invoke-RestMethod -Method Post -Uri "$baseUri/api-keys?reveal=true" -Headers $headers -ContentType 'application/json' -Body $keyBody
    if ($createdKey.type -ne 'publishable' -or -not ([string]$createdKey.api_key).StartsWith('sb_publishable_')) {
      throw 'Supabase did not return the required dedicated publishable API key.'
    }
    $accessToken = New-ShadowJwt ([string]$postgrest.jwt_secret)
    Set-LocalEnvironmentValue $EnvironmentFile 'V2_SHADOW_SUPABASE_URL' $projectUrl
    Set-LocalEnvironmentValue $EnvironmentFile 'V2_SHADOW_SUPABASE_READ_KEY' ''
    Set-LocalEnvironmentValue $EnvironmentFile 'V2_SHADOW_SUPABASE_PUBLISHABLE_KEY' ([string]$createdKey.api_key)
    Set-LocalEnvironmentValue $EnvironmentFile 'V2_SHADOW_SUPABASE_ACCESS_TOKEN' $accessToken
    Set-LocalEnvironmentValue $EnvironmentFile 'V2_SHADOW_SUPABASE_SCHEMA' $shadowSchema
    Set-LocalEnvironmentValue $EnvironmentFile 'V2_SHADOW_ALLOW_PRODUCTION_READS' 'false'
    [ordered]@{
      status = 'PROVISIONED'
      readerRoleCreated = $true
      viewOwnerRoleCreated = $true
      schemaExposed = $true
      dedicatedPublishableKeyCreated = $true
      shortLivedJwtCreated = $true
      jwtLifetimeSeconds = 3600
      credentialsStoredLocally = $true
      productionReadsRemainDisabled = $true
    } | ConvertTo-Json
  } catch {
    Clear-LocalShadowCredentials
    if ($null -ne $createdKey) {
      try {
        $createdKeyId = ([Guid]([string]$createdKey.id)).ToString('D')
        $createdKeyDeleteUri = [Uri]::new("$baseUri/api-keys/$createdKeyId")
        $null = Invoke-RestMethod -Method Delete -Uri $createdKeyDeleteUri.AbsoluteUri -Headers $headers
      } catch {}
    }
    if ($schemaExposed) { try { Set-DataApiSchemas ($originalSchemas -join ',') } catch {} }
    if ($sqlApplied) { try { Invoke-DatabaseSql $rollbackSqlPath } catch {} }
    throw
  }
} finally {
  $managementToken = $null
  $headers = $null
  if ($null -ne $postgrest) { $postgrest.jwt_secret = $null }
  $postgrest = $null
  $accessToken = $null
}

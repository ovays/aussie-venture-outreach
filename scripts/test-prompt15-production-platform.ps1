param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9]{20}$')]
  [string]$ProjectRef
)

$ErrorActionPreference = 'Stop'

if (-not ('Prompt15.PlatformCredential' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Prompt15 {
  public static class PlatformCredential {
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

$token = [Prompt15.PlatformCredential]::ReadGeneric('Supabase CLI:supabase')
try {
  $headers = @{ Authorization = "Bearer $token" }
  $postgrest = Invoke-RestMethod -Method Get -Uri "https://api.supabase.com/v1/projects/$ProjectRef/postgrest" -Headers $headers
  $keys = Invoke-RestMethod -Method Get -Uri "https://api.supabase.com/v1/projects/$ProjectRef/api-keys" -Headers $headers
  $schemaNames = @($postgrest.db_schema -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $keyItems = @($keys | ForEach-Object {
    [ordered]@{
      id = $_.id
      type = $_.type
      name = $_.name
      prefix = $_.prefix
    }
  })
  [ordered]@{
    status = 'PASS'
    dataApiSchemas = $schemaNames
    shadowSchemaAlreadyExposed = $schemaNames -contains 'reachagent_prompt15_shadow'
    trustedLegacyJwtSigningAvailable = -not [string]::IsNullOrWhiteSpace([string]$postgrest.jwt_secret)
    existingApiKeys = $keyItems
    dedicatedPrompt15PublishableKeyExists = @($keyItems | Where-Object {
      $_.type -eq 'publishable' -and $_.name -eq 'reachagent_prompt15_shadow_reader'
    }).Count -gt 0
  } | ConvertTo-Json -Depth 8
} finally {
  $token = $null
  $headers = $null
  if ($null -ne $postgrest) { $postgrest.jwt_secret = $null }
  $postgrest = $null
}

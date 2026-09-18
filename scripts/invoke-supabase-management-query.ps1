param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9]{20}$')]
  [string]$ProjectRef,

  [Parameter(Mandatory = $true)]
  [string]$QueryFile,

  [switch]$ReadOnly
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $QueryFile -PathType Leaf)) {
  throw "SQL query file not found: $QueryFile"
}

if (-not ('Prompt15.NativeCredential' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Prompt15 {
  public static class NativeCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public uint Flags;
      public uint Type;
      public IntPtr TargetName;
      public IntPtr Comment;
      public long LastWritten;
      public uint CredentialBlobSize;
      public IntPtr CredentialBlob;
      public uint Persist;
      public uint AttributeCount;
      public IntPtr Attributes;
      public IntPtr TargetAlias;
      public IntPtr UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr credential);

    public static string ReadGeneric(string target) {
      IntPtr pointer;
      if (!CredRead(target, 1, 0, out pointer)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read the existing Supabase CLI credential.");
      }
      try {
        Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
        if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) {
          throw new InvalidOperationException("The Supabase CLI credential is empty.");
        }
        byte[] buffer = new byte[credential.CredentialBlobSize];
        Marshal.Copy(credential.CredentialBlob, buffer, 0, (int)credential.CredentialBlobSize);
        return Encoding.UTF8.GetString(buffer).TrimEnd('\0');
      } finally {
        CredFree(pointer);
      }
    }
  }
}
'@
}

$token = [Prompt15.NativeCredential]::ReadGeneric('Supabase CLI:supabase')
try {
  $query = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $QueryFile).Path)
  $suffix = if ($ReadOnly) { '/read-only' } else { '' }
  $uri = "https://api.supabase.com/v1/projects/$ProjectRef/database/query$suffix"
  $headers = @{ Authorization = "Bearer $token" }
  $body = @{ query = $query } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $body
  $result | ConvertTo-Json -Depth 20
} finally {
  $token = $null
  $headers = $null
}

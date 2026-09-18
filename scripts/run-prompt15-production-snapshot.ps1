<#
.SYNOPSIS
  Executes the reviewed Prompt 15 sanitized snapshot statement against V1 production
  exactly once, through the operator-run Supabase Management API database-query path.

.DESCRIPTION
  This is an operator audit read, not a V2 runtime connection. It creates no role,
  schema, view, policy, function, JWT, or API key, and changes no ACL.

  Order of operations, all fail-closed:
    1. Refuse to run if a snapshot already exists (guards against a second execution).
    2. Validate the SQL lexically: single statement, starts WITH/SELECT, no mutating
       or DDL keyword, no mutating/locking function call, hard LIMIT 100.
    3. POST the statement once with read_only:true. If the API rejects the field
       (or any other failure occurs), STOP AND REPORT. Never retry without read_only.
    4. Write rows to a git-ignored local file. Rows are never printed.
    5. Scan the saved rows against the approved field allowlist and the PII patterns.
       On any failure the snapshot is deleted and the script exits non-zero.

.PARAMETER ProjectRef
  The V1 production Supabase project reference.

.PARAMETER DryRun
  Validate the statement and print the plan without contacting production.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9]{20}$')]
  [string]$ProjectRef,

  [switch]$DryRun,

  [string]$QueryPath = 'scripts/prompt15-sanitized-snapshot.sql',
  [string]$OutputPath = '.v2-local/prompt15-real-shadow-snapshot.json',
  [string]$LedgerPath = '.v2-local/prompt15-production-execution-ledger.json'
)

$ErrorActionPreference = 'Stop'

# Self-contained reader for the operator's existing Supabase CLI management token.
# The token is never written to disk, logged, or echoed.
if (-not ('Prompt15.SnapshotCredential' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace Prompt15 {
  public static class SnapshotCredential {
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

function Get-Sha256([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) }
  finally { $sha.Dispose() }
}

function Add-LedgerEntry([hashtable]$Entry) {
  $entries = @()
  if (Test-Path -LiteralPath $LedgerPath) {
    $existing = Get-Content -Raw -LiteralPath $LedgerPath | ConvertFrom-Json
    if ($null -ne $existing) { $entries = @($existing) }
  }
  $entries += [pscustomobject]$Entry
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LedgerPath)
  ($entries | ConvertTo-Json -Depth 6) | Out-File -LiteralPath $LedgerPath -Encoding utf8
}

# ── 1. Never execute twice ──────────────────────────────────────────────────
if ((Test-Path -LiteralPath $OutputPath) -and -not $DryRun) {
  throw "A Prompt 15 snapshot already exists at $OutputPath. Delete it deliberately before re-running."
}

# ── 2. Fail-closed SQL validation ───────────────────────────────────────────
$sql = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $QueryPath).Path)
$validation = & npx tsx scripts/prompt15-snapshot-safety.ts $QueryPath | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $validation.status -ne 'PASS') { throw 'Snapshot SQL failed safety validation.' }
$queryHash = [string]$validation.queryHash
$targetIdentityHash = Get-Sha256 "supabase-project:$ProjectRef"

if ($DryRun) {
  [ordered]@{
    mode                = 'DRY_RUN'
    queryHash           = $queryHash
    targetIdentityHash  = $targetIdentityHash
    statementBytes      = $sql.Length
    productionRequests  = 0
  } | ConvertTo-Json
  exit 0
}

# ── 3. Exactly one production request ───────────────────────────────────────
$managementToken = $null
$headers = $null
$response = $null
$readOnlyEnforced = $true
$executedAt = [DateTimeOffset]::UtcNow.ToString('o')

try {
  $managementToken = [Prompt15.SnapshotCredential]::ReadGeneric('Supabase CLI:supabase')
  $headers = @{ Authorization = "Bearer $managementToken" }
  $uri = "https://api.supabase.com/v1/projects/$ProjectRef/database/query"

  $body = @{ query = $sql; read_only = $true } | ConvertTo-Json -Compress
  try {
    $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $body
  } catch {
    $statusCode = $null
    if ($null -ne $_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    # read_only:true is mandatory. If the API rejects it (or any other failure
    # occurs), STOP AND REPORT. Never retry without read_only.
    Add-LedgerEntry @{ at = $executedAt; outcome = 'READ_ONLY_REQUIRED_STOPPED'; targetIdentityHash = $targetIdentityHash; queryHash = $queryHash; rowsRead = 0; statusCode = $statusCode }
    throw "read_only:true request failed (HTTP $statusCode). STOPPED without issuing a non-read-only query."
  }
} finally {
  $managementToken = $null
  $headers = $null
}

$rows = @($response)
if ($rows.Count -gt 100) { throw "Production returned $($rows.Count) rows, above the hard maximum of 100." }

# ── 4. Save locally, never print ────────────────────────────────────────────
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath)
$payload = [ordered]@{
  meta = [ordered]@{
    source                      = 'v1-production-sanitized-snapshot'
    targetIdentityHash          = $targetIdentityHash
    queryHash                   = $queryHash
    executedAt                  = $executedAt
    productionSelectExecutions  = 1
    readOnlyEnforced            = $readOnlyEnforced
    rowCount                    = $rows.Count
  }
  rows = $rows
}
# UTF-8 without BOM: the downstream Node validator JSON.parse must never see a
# leading U+FEFF (Windows PowerShell 5.1 `Out-File -Encoding utf8` adds one).
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, ($payload | ConvertTo-Json -Depth 12), $utf8NoBom)

# ── 5. Privacy validation; delete and stop on any failure ───────────────────
& npx tsx scripts/prompt15-snapshot-safety.ts $QueryPath $OutputPath | Out-Null
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $OutputPath -Force -Confirm:$false
  Add-LedgerEntry @{ at = $executedAt; outcome = 'PRIVACY_SCAN_FAILED_SNAPSHOT_DELETED'; targetIdentityHash = $targetIdentityHash; queryHash = $queryHash; rowsRead = $rows.Count }
  throw 'Snapshot failed privacy validation. The snapshot has been deleted. STOP.'
}

Add-LedgerEntry @{ at = $executedAt; outcome = 'SUCCESS'; targetIdentityHash = $targetIdentityHash; queryHash = $queryHash; rowsRead = $rows.Count; readOnlyEnforced = $readOnlyEnforced }

[ordered]@{
  status                     = 'SNAPSHOT_CAPTURED'
  productionSelectExecutions = 1
  rowCount                   = $rows.Count
  queryHash                  = $queryHash
  targetIdentityHash         = $targetIdentityHash
  executedAt                 = $executedAt
  readOnlyEnforced           = $readOnlyEnforced
  privacyScan                = 'PASS'
  snapshotPath               = $OutputPath
} | ConvertTo-Json

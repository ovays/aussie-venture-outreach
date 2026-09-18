param(
  [string]$ProjectRef = $env:V2_SUPABASE_PROJECT_REF
)

$ErrorActionPreference = 'Stop'
$KnownV1ProjectRef = 'obppfnujusqiwjhwzosv'
if (-not $ProjectRef) { throw 'Set V2_SUPABASE_PROJECT_REF explicitly.' }
$ProjectRef = $ProjectRef.Trim().ToLowerInvariant()
if ($ProjectRef -eq $KnownV1ProjectRef) { throw 'Known V1 production Supabase project rejected.' }
$databaseUrl = $env:V2_SUPABASE_DB_URL
if (-not $databaseUrl) { throw 'Set V2_SUPABASE_DB_URL for the isolated V2 database.' }
try { $databaseUri = [Uri]$databaseUrl } catch { throw 'V2_SUPABASE_DB_URL is invalid.' }
$targetIdentity = ($databaseUri.Host + ' ' + $databaseUri.UserInfo).ToLowerInvariant()
if ($targetIdentity.Contains($KnownV1ProjectRef) -or -not $targetIdentity.Contains($ProjectRef)) {
  throw 'Database URL does not identify the explicit non-V1 V2 project ref.'
}
$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) { throw 'psql is required. Install PostgreSQL client tools, then rerun this script.' }
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$verificationSql = Join-Path $repositoryRoot 'supabase-v2\tests\verify_hosted_v2.sql'
$report = Join-Path $repositoryRoot 'docs\reachagent-v2-hosted-db-verification.txt'

& $psql.Source --no-psqlrc --dbname=$databaseUrl --set ON_ERROR_STOP=1 --file=$verificationSql 2>&1 | Tee-Object -FilePath $report
if ($LASTEXITCODE -ne 0) { throw 'Hosted V2 catalog/security verification failed.' }
Write-Output "REACHAGENT_V2_HOSTED_DB_VERIFY_PASS report=$report"

param(
  [string]$ProjectRef = $env:V2_SUPABASE_PROJECT_REF
)

$ErrorActionPreference = 'Stop'
$KnownV1ProjectRef = 'obppfnujusqiwjhwzosv'
$ExpectedFiles = @(
  @{ Name = '00000000000000_reachagent_v2_golden_baseline.sql'; Hash = '797D845B5505D7BA6B5AFE856582D4D08B9919614BBD791E507C81A9235C24C4' },
  @{ Name = '00000000000001_performance_reliability.sql'; Hash = '75DA9844FB2BAAFC3CF1E46AE8E85E792F256CCD22909FB759D5090DF95D25D1' },
  @{ Name = '00000000000002_observability_foundation.sql'; Hash = 'CB07CE3BA5D469B8F47B168923D16FC7BEE8CC9208609A04C33E9534BD2E544B' },
  @{ Name = '00000000000003_v2_canary_send_claim.sql'; Hash = '24957C16FB13930B9614F57A3023C56016058003F611F19DD25CC86776CB8511' }
)

if (-not $ProjectRef) { throw 'Set V2_SUPABASE_PROJECT_REF explicitly.' }
$ProjectRef = $ProjectRef.Trim().ToLowerInvariant()
if ($ProjectRef -eq $KnownV1ProjectRef) { throw 'Known V1 production Supabase project rejected.' }
if ($ProjectRef -notmatch '^[a-z0-9]{20}$') { throw 'V2 Supabase project ref has an invalid shape.' }
if ($env:REACHAGENT_ENV -notin @('v2_staging', 'v2_canary')) { throw 'Hosted baseline requires REACHAGENT_ENV=v2_staging or v2_canary.' }
if ($env:NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF -ne $ProjectRef) { throw 'Public V2 project ref does not match the explicit hosted target.' }

$databaseUrl = $env:V2_SUPABASE_DB_URL
if (-not $databaseUrl) { throw 'Set V2_SUPABASE_DB_URL for the new empty V2 project.' }
try { $databaseUri = [Uri]$databaseUrl } catch { throw 'V2_SUPABASE_DB_URL is invalid.' }
if ($databaseUri.Scheme -notin @('postgres', 'postgresql')) { throw 'V2 hosted baseline requires a PostgreSQL URL.' }
$targetIdentity = ($databaseUri.Host + ' ' + $databaseUri.UserInfo).ToLowerInvariant()
if ($targetIdentity.Contains($KnownV1ProjectRef)) { throw 'Known V1 production database URL rejected.' }
if (-not $targetIdentity.Contains($ProjectRef)) { throw 'Database URL does not identify the explicit V2 project ref.' }

foreach ($gate in @('ORCHESTRATOR_ENABLED','ORCHESTRATOR_SHADOW','OUTREACH_SEND_ENABLED','TRIGGER_JOBS_ENABLED','FINDER_SCHEDULE_ENABLED','HOSTINGER_MUTATIONS_ENABLED','SHADOW_OBSERVABILITY_WRITE_ENABLED','V2_SHADOW_ALLOW_PRODUCTION_READS')) {
  if ([Environment]::GetEnvironmentVariable($gate) -ne 'false') { throw "Hosted baseline requires explicit $gate=false." }
}
foreach ($alias in @('TRIGGER_SECRET_KEY_PROD','TRIGGER_PROJECT_ID','SUPABASE_URL_PROD','NEXT_PUBLIC_SUPABASE_URL_PROD','SUPABASE_SERVICE_ROLE_KEY_PROD','V1_SUPABASE_URL','V1_SUPABASE_SERVICE_ROLE_KEY','V2_SHADOW_SUPABASE_URL','V2_SHADOW_SUPABASE_READ_KEY','V2_SHADOW_SUPABASE_PUBLISHABLE_KEY','V2_SHADOW_SUPABASE_ACCESS_TOKEN','V2_SHADOW_SUPABASE_SCHEMA')) {
  if ([Environment]::GetEnvironmentVariable($alias)) { throw "Hosted baseline forbids $alias." }
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) { throw 'psql is required. Install PostgreSQL client tools, then rerun this script.' }
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$migrationRoot = Join-Path $repositoryRoot 'supabase-v2\migrations'
$actualFiles = @(Get-ChildItem -LiteralPath $migrationRoot -File -Filter '*.sql' | Sort-Object Name)
if ($actualFiles.Count -ne $ExpectedFiles.Count) { throw 'V2 migration root must contain exactly the approved migrations.' }
for ($index = 0; $index -lt $ExpectedFiles.Count; $index++) {
  $expected = $ExpectedFiles[$index]
  if ($actualFiles[$index].Name -ne $expected.Name) { throw 'Unexpected V2 migration inventory or order.' }
  if ((Get-FileHash -LiteralPath $actualFiles[$index].FullName -Algorithm SHA256).Hash -ne $expected.Hash) {
    throw "Verified V2 migration hash mismatch: $($expected.Name)"
  }
}

$tableCount = & $psql.Source --no-psqlrc --dbname=$databaseUrl --tuples-only --no-align --set ON_ERROR_STOP=1 --command="SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','m','S');"
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the hosted V2 destination.' }
if ([int]($tableCount.Trim()) -ne 0) { throw 'Hosted V2 public schema is not empty/new; refusing baseline apply.' }

foreach ($migration in $actualFiles) {
  & $psql.Source --no-psqlrc --dbname=$databaseUrl --set ON_ERROR_STOP=1 --single-transaction --file=$($migration.FullName)
  if ($LASTEXITCODE -ne 0) { throw "Hosted V2 migration failed: $($migration.Name)" }
}

& (Join-Path $PSScriptRoot 'verify-v2-hosted-db.ps1') -ProjectRef $ProjectRef
if ($LASTEXITCODE -ne 0) { throw 'Hosted V2 verification failed.' }
Write-Output 'REACHAGENT_V2_HOSTED_BASELINE_APPLY_PASS'

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$migrationRoot = Join-Path $repositoryRoot 'supabase-v2\migrations'
$baseline = Join-Path $migrationRoot '00000000000000_reachagent_v2_golden_baseline.sql'
$platformPrep = Join-Path $repositoryRoot 'supabase-v2\build\prepare_local_supabase.sql'
$expectedHash = '797D845B5505D7BA6B5AFE856582D4D08B9919614BBD791E507C81A9235C24C4'
$container = 'supabase_db_reachagent-v2-local'

$migrationFiles = @(Get-ChildItem -LiteralPath $migrationRoot -File -Filter '*.sql' | Sort-Object Name)
if ($migrationFiles.Count -lt 1 -or $migrationFiles[0].FullName -ne $baseline) {
  throw 'V2 apply requires the immutable golden baseline as the first migration.'
}
if ((Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash -ne $expectedHash) {
  throw 'V2 golden baseline hash does not match the verified artifact.'
}

$running = docker inspect --format '{{.State.Running}}' $container 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
  throw "The isolated local V2 database container is not running: $container"
}

$tableCount = docker exec $container psql -U supabase_admin -d postgres -At -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r';"
if ($LASTEXITCODE -ne 0 -or [int]$tableCount -ne 0) {
  throw 'The V2 public schema is not empty; refusing to reapply the baseline.'
}

Get-Content -Raw -LiteralPath $platformPrep |
  docker exec -i $container psql --set ON_ERROR_STOP=1 -U supabase_admin -d postgres
if ($LASTEXITCODE -ne 0) { throw 'Local Supabase platform ACL preparation failed.' }

Get-Content -Raw -LiteralPath $baseline |
  docker exec -i $container psql --set ON_ERROR_STOP=1 -U supabase_admin -d postgres
if ($LASTEXITCODE -ne 0) { throw 'V2 golden baseline apply failed.' }

foreach ($migration in $migrationFiles | Select-Object -Skip 1) {
  Get-Content -Raw -LiteralPath $migration.FullName |
    docker exec -i $container psql --set ON_ERROR_STOP=1 -U supabase_admin -d postgres
  if ($LASTEXITCODE -ne 0) { throw "V2 incremental migration failed: $($migration.Name)" }
}

Write-Output 'REACHAGENT_V2_BASELINE_APPLY_PASS'

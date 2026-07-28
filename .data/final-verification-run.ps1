$ErrorActionPreference = 'Stop'

$categories = @(
  'Halal Restaurants',
  'Halal Cafes',
  'Halal Bakeries / Dessert Shops',
  'Escape Rooms',
  'VR Experiences',
  'Go Karting',
  'Bowling & Entertainment',
  'Mini Golf',
  'Theme Parks',
  'Hotels / Resorts',
  'Tour Operators',
  'Travel Agents',
  'Cruises',
  'Beauty / Lash Studios',
  'Hair Salons',
  'Nail Salons',
  'Spas / Massage Studios'
)

$outputDirectory = Join-Path (Get-Location) '.data\final-verification'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

for ($index = 0; $index -lt $categories.Count; $index++) {
  $category = $categories[$index]
  $number = ($index + 1).ToString('00')
  $slug = ($category.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
  $outputPath = Join-Path $outputDirectory "$number-$slug.txt"

  Write-Output "START $number $category"
  & npx.cmd tsx scripts\tmp-sequence-preview.ts $category |
    Out-File -LiteralPath $outputPath -Encoding utf8

  if ($LASTEXITCODE -ne 0) {
    throw "Generation failed for $category with exit code $LASTEXITCODE"
  }

  Write-Output "DONE  $number $category"
}

Write-Output 'ALL GENERATIONS COMPLETE'

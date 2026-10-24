$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'output'))
$projectPrefix = $projectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

function Get-ProjectRelativePath([string] $fullPath) {
    $resolvedPath = [System.IO.Path]::GetFullPath($fullPath)
    if (-not $resolvedPath.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Package file resolved outside the project: $resolvedPath"
    }
    return $resolvedPath.Substring($projectPrefix.Length)
}

if (-not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

$baseName = 'FlightGuard_Submission_Package_' + (Get-Date -Format 'yyyy-MM-dd')
$archivePath = Join-Path $outputDirectory ($baseName + '.zip')
if (Test-Path -LiteralPath $archivePath) {
    $archivePath = Join-Path $outputDirectory ($baseName + '-' + (Get-Date -Format 'HHmmss') + '.zip')
}

$rootFiles = @(
    '.env.example',
    '.gitignore',
    'package.json',
    'package-lock.json',
    'playwright.config.ts',
    'README.md',
    'tsconfig.base.json'
)

$includedDirectories = @(
    'apps',
    'packages',
    'data',
    'docs',
    'research',
    'tests',
    'reports'
)

$files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
foreach ($relativePath in $rootFiles) {
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Required package file is missing: $relativePath"
    }
    $files.Add((Get-Item -LiteralPath $fullPath))
}

foreach ($relativeDirectory in $includedDirectories) {
    $fullDirectory = Join-Path $projectRoot $relativeDirectory
    if (-not (Test-Path -LiteralPath $fullDirectory -PathType Container)) {
        throw "Required package directory is missing: $relativeDirectory"
    }

    Get-ChildItem -LiteralPath $fullDirectory -File -Recurse | Where-Object {
        $relative = Get-ProjectRelativePath $_.FullName
        $packageRelative = $relative.Replace('\', '/')
        $segments = $relative -split '[\\/]'
        'node_modules' -notin $segments -and
        'dist' -notin $segments -and
        $packageRelative -notlike 'research/real-data/raw/*' -and
        $_.Name -notlike '*.zip' -and
        $_.Name -notlike '*.part' -and
        $_.Name -ne '.env' -and
        $_.Name -notlike '*.local.json' -and
        $_.Name -notlike 'live-evaluation-*.json'
    } | ForEach-Object { $files.Add($_) }
}

$files.Add((Get-Item -LiteralPath (Join-Path $PSScriptRoot 'package.ps1')))

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archiveStream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::CreateNew)
try {
    $archive = [System.IO.Compression.ZipArchive]::new(
        $archiveStream,
        [System.IO.Compression.ZipArchiveMode]::Create,
        $false,
        [System.Text.Encoding]::UTF8
    )
    try {
        foreach ($file in ($files | Sort-Object FullName -Unique)) {
            $entryName = (Get-ProjectRelativePath $file.FullName).Replace('\', '/')
            $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            $fileStream = $file.OpenRead()
            try {
                $fileStream.CopyTo($entryStream)
            }
            finally {
                $fileStream.Dispose()
                $entryStream.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    $archiveStream.Dispose()
}

$resolvedArchive = [System.IO.Path]::GetFullPath($archivePath)
$outputPrefix = $outputDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedArchive.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Archive target resolved outside the output directory.'
}

$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
$hashStream = [System.IO.File]::OpenRead($resolvedArchive)
try {
    $archiveHash = [System.BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '')
}
finally {
    $hashStream.Dispose()
    $hashAlgorithm.Dispose()
}
$checksumPath = [System.IO.Path]::ChangeExtension($resolvedArchive, '.sha256.txt')
$checksumLine = $archiveHash + '  ' + [System.IO.Path]::GetFileName($resolvedArchive) + [Environment]::NewLine
[System.IO.File]::WriteAllText($checksumPath, $checksumLine, [System.Text.UTF8Encoding]::new($false))

Write-Output $resolvedArchive
Write-Output $checksumPath

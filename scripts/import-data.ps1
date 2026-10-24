param([string]$InputFile = (Join-Path $PSScriptRoot '../../HackSHSID 2026/Track 3 Data.xlsx'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $InputFile))
function Read-Entry($name) {
    $reader = [System.IO.StreamReader]::new($archive.GetEntry($name).Open())
    try { $reader.ReadToEnd() } finally { $reader.Dispose() }
}
try {
    [xml]$workbook = Read-Entry 'xl/workbook.xml'
    [xml]$relations = Read-Entry 'xl/_rels/workbook.xml.rels'
    $strings = @()
    if ($archive.GetEntry('xl/sharedStrings.xml')) {
        [xml]$shared = Read-Entry 'xl/sharedStrings.xml'
        $strings = @($shared.sst.si | ForEach-Object { $_.InnerText })
    }
    $tables = [ordered]@{}
    foreach ($sheet in $workbook.workbook.sheets.sheet) {
        $rid = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
        $target = ($relations.Relationships.Relationship | Where-Object Id -eq $rid).Target
        $entry = if ($target.StartsWith('/')) { $target.TrimStart('/') } else { 'xl/' + $target }
        [xml]$xml = Read-Entry $entry
        $headers = @{}
        $records = @()
        foreach ($row in $xml.worksheet.sheetData.row) {
            $record = [ordered]@{}
            foreach ($cell in $row.c) {
                $column = $cell.r -replace '\d', ''
                $value = if ($cell.t -eq 's') { $strings[[int]$cell.v] } elseif ($cell.t -eq 'inlineStr') { $cell.is.InnerText } else { [string]$cell.v }
                if ($row.r -eq '1') { $headers[$column] = $value }
                elseif ($headers.ContainsKey($column)) { $record[$headers[$column]] = $value }
            }
            if ($row.r -ne '1') { $records += $record }
        }
        $tables[$sheet.name] = $records
    }
    $output = Join-Path $PSScriptRoot '../data/dataset.json'
    New-Item -ItemType Directory -Force (Split-Path $output) | Out-Null
    $tables | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $output -Encoding utf8
    Write-Output ('Imported ' + $tables.Count + ' sheets to dataset.json')
} finally { $archive.Dispose() }

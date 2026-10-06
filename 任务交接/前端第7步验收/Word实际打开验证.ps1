param([switch]$Wide)
$ErrorActionPreference = 'Stop'
$taskDirectory = $PSScriptRoot
$taskSource = Join-Path $taskDirectory '业务报表.docx'
$taskEdited = Join-Path $taskDirectory 'Word编辑验证.docx'
$taskPdf = Join-Path $taskDirectory 'Word实际排版.pdf'
$taskJson = Join-Path $taskDirectory 'Word实际打开验证.json'
$taskExpected = '门诊与费用月报'
if ($Wide) {
    $taskSource = Join-Path $taskDirectory '长标题200行宽表.docx'
    $taskEdited = Join-Path $taskDirectory 'Word宽表编辑验证.docx'
    $taskPdf = Join-Path $taskDirectory 'Word宽表实际排版.pdf'
    $taskJson = Join-Path $taskDirectory 'Word宽表实际打开验证.json'
    $taskExpected = '终值200'
}
$taskResult = @{ opened = $false; editable = $false; rendered = $false }
$taskWord = $null
$taskDocument = $null
$taskOwnInstance = $false
try {
    $taskWord = New-Object -ComObject Word.Application
    if ($taskWord.Documents.Count -gt 0) { throw 'Word 实例包含已有文档，保留用户窗口并跳过自动化。' }
    $taskOwnInstance = $true
    $taskWord.Visible = $false
    $taskWord.DisplayAlerts = 0
    $taskDocument = $taskWord.Documents.Open($taskSource, $false, $false)
    $taskResult.opened = $true
    if (-not $taskDocument.Content.Text.Contains($taskExpected)) { throw 'Word 未能读取预期中文。' }
    $taskDocument.Content.InsertAfter("`r编辑验收：此段由 Word 原生编辑加入。")
    $taskDocument.SaveAs2($taskEdited, 16)
    $taskResult.editable = $true
    $taskDocument.ExportAsFixedFormat($taskPdf, 17)
    $taskResult.rendered = Test-Path -LiteralPath $taskPdf
    $taskResult.pages = $taskDocument.ComputeStatistics(2)
} catch { $taskResult.error = $_.Exception.Message }
finally {
    if ($null -ne $taskDocument) { $taskDocument.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($taskDocument) }
    if ($taskOwnInstance) { $taskWord.Quit() }
    if ($null -ne $taskWord) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($taskWord) }
    $taskResult | ConvertTo-Json | Set-Content -LiteralPath $taskJson -Encoding utf8
    $taskResult | ConvertTo-Json
}

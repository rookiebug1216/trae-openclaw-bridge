# ==============================================================================
# deploy-trae.ps1 — 把 Trae 侧 openclaw 插件安装到本机 Trae
#
# 一次铺三处：
#   1. 插件包  -> %USERPROFILE%\.trae-cn\plugins\local\openclaw\<version>\
#   2. 技能    -> %USERPROFILE%\.trae-cn\skills\openclaw\
#   3. MCP     -> .trae-cn\mcp.json 与 %APPDATA%\Trae CN\User\mcp.json（合并写入，保留其它 server）
#
# 为什么还要写 mcp.json：
#   Trae 的「插件市场列表」由服务端 registry 驱动，本地 plugins\local\ 目录不会被登记。
#   plugin.json 里的 mcpServers 只有在「经服务端安装」时才会被自动派生，
#   所以本地分发必须同时把 MCP server 显式挂到 mcp.json。
#   技能目录则是 Trae 真实扫描的本地通道（scanLocalSkills），放进去即可生效。
#
# 安全红线：绝不执行交互式 Trae 操作；不打印 token。
# ==============================================================================
param()

$ErrorActionPreference = "Stop"

$RepoRoot   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PluginSrc  = Join-Path $RepoRoot "packages\trae-openclaw-plugin"
$TraeHome   = Join-Path $env:USERPROFILE ".trae-cn"

# --- 读取插件名与版本（目标路径必须与版本一致） ---
$ManifestPath = Join-Path $PluginSrc ".trae-plugin\plugin.json"
if (-not (Test-Path $ManifestPath)) { throw "plugin.json not found: $ManifestPath" }
$Manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$PluginName = $Manifest.name
$Version    = $Manifest.version
if (-not $PluginName -or -not $Version) { throw "plugin.json missing name/version" }

$TargetDir = Join-Path $TraeHome "plugins\local\$PluginName\$Version"
$SkillSrc  = Join-Path $PluginSrc "skills\$PluginName"
$SkillDst  = Join-Path $TraeHome "skills\$PluginName"
$McpIndex  = Join-Path $TargetDir "mcp\index.mjs"

function Invoke-Step([string]$Title, [scriptblock]$Action) {
    Write-Host ""
    Write-Host ("=" * 60) -ForegroundColor Cyan
    Write-Host " STEP: $Title" -ForegroundColor Cyan
    Write-Host ("=" * 60) -ForegroundColor Cyan
    & $Action
    Write-Host "  OK" -ForegroundColor Green
}

Write-Host ""
Write-Host "Trae <=> OpenClaw - Trae side install" -ForegroundColor Magenta
Write-Host "  Plugin src: $PluginSrc"
Write-Host "  Version:    $Version"
Write-Host "  Target:     $TargetDir"
Write-Host ""

# --- Step 1: 依赖 ---
Invoke-Step "npm install --omit=dev" {
    Push-Location $PluginSrc
    try {
        if (-not (Test-Path "node_modules")) {
            cmd /c "npm install --omit=dev 2>nul"
        }
    } finally {
        Pop-Location
    }
}

# --- Step 2: 插件包 -> plugins\local\ ---
Invoke-Step "Install plugin package" {
    if (Test-Path $TargetDir) { Remove-Item -Recurse -Force $TargetDir }
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    foreach ($item in @("mcp", ".trae-plugin", "skills", "assets")) {
        Copy-Item -Path (Join-Path $PluginSrc $item) -Destination $TargetDir -Recurse -Force
    }
    Copy-Item -Path (Join-Path $PluginSrc "package.json") -Destination $TargetDir -Force
    if (Test-Path (Join-Path $PluginSrc "node_modules")) {
        Copy-Item -Path (Join-Path $PluginSrc "node_modules") -Destination $TargetDir -Recurse -Force
    }
    Write-Host "  -> $TargetDir"
}

# --- Step 3: 技能 -> %USERPROFILE%\.trae-cn\skills\（Trae 扫描的本地通道） ---
Invoke-Step "Install skill (local scan channel)" {
    if (-not (Test-Path $SkillSrc)) { throw "skill dir not found: $SkillSrc" }
    if (Test-Path $SkillDst) { Remove-Item -Recurse -Force $SkillDst }
    New-Item -ItemType Directory -Path $SkillDst -Force | Out-Null
    Copy-Item -Path (Join-Path $SkillSrc "*") -Destination $SkillDst -Recurse -Force
    Write-Host "  -> $SkillDst"
}

# --- Step 4: MCP server -> mcp.json（合并写入，保留已有 server） ---
Invoke-Step "Register MCP server in mcp.json" {
    $targets = @((Join-Path $TraeHome "mcp.json"))
    if ($env:APPDATA) { $targets += (Join-Path $env:APPDATA "Trae CN\User\mcp.json") }

    foreach ($file in $targets) {
        $dir = Split-Path -Parent $file
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

        # 解析已有配置；解析失败则原样保留，不破坏用户文件
        $cfg = $null
        if (Test-Path $file) {
            $raw = Get-Content $file -Raw -Encoding UTF8
            if ($raw -and $raw.Trim()) {
                try { $cfg = $raw | ConvertFrom-Json } catch {
                    Write-Host "  ! invalid JSON, left untouched: $file" -ForegroundColor Yellow
                    continue
                }
            }
        }
        if (-not $cfg) { $cfg = New-Object psobject }

        if (-not ($cfg.PSObject.Properties.Name -contains "mcpServers") -or -not $cfg.mcpServers) {
            $cfg | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue (New-Object psobject) -Force
        }

        $entry = [ordered]@{
            command = "node"
            args    = @($McpIndex)
            env     = [ordered]@{ NODE_TLS_REJECT_UNAUTHORIZED = "0" }
        }
        $cfg.mcpServers | Add-Member -NotePropertyName $PluginName -NotePropertyValue $entry -Force

        $json = $cfg | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($file, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
        Write-Host "  -> $file"
    }
}

# --- Step 5: 结果 ---
Write-Host ""
Write-Host "---- installed files ----" -ForegroundColor DarkGray
Get-ChildItem $TargetDir -Recurse -File |
    Where-Object { $_.FullName -notmatch "\\node_modules\\" } |
    ForEach-Object { Write-Host "  $($_.FullName.Replace($TargetDir + '\', ''))" }

Write-Host ""
Write-Host ("=" * 60) -ForegroundColor Green
Write-Host " Trae-side install done" -ForegroundColor Green
Write-Host ("=" * 60) -ForegroundColor Green
Write-Host ""
Write-Host " NEXT STEPS:" -ForegroundColor Yellow
Write-Host "  1. Restart Trae IDE (MCP config changes require a restart)" -ForegroundColor White
Write-Host "  2. MCP panel should list 'openclaw' with 6 tools" -ForegroundColor White
Write-Host "  3. Skills panel should list 'openclaw' (from .trae-cn\skills)" -ForegroundColor White
Write-Host ""
Write-Host " NOTE: the plugin marketplace list will NOT contain this plugin." -ForegroundColor DarkGray
Write-Host "       That list is server-registry driven; plugins\local\ is not registered." -ForegroundColor DarkGray
Write-Host ""

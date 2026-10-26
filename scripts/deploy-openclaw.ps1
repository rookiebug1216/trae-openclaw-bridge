# ==============================================================================
# deploy-openclaw.ps1 — 部署 OpenClaw 侧 trae 插件 + 启用依赖 + 健康验证
# （实测有效路径：direct copy + openclaw config patch/set + gateway restart）
# ==============================================================================
param()

$ErrorActionPreference = "Stop"

$RepoRoot      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PluginSrc     = Join-Path $RepoRoot "packages\openclaw-trae-plugin"
$OpenClawHome  = Join-Path $env:USERPROFILE ".openclaw"
$ExtensionsDir = Join-Path $OpenClawHome "extensions"
$DestDir       = Join-Path $ExtensionsDir "trae"
$ConfigFile    = Join-Path $OpenClawHome "openclaw.json"
$BridgeFile    = Join-Path $OpenClawHome "trae-bridge.json"
$Timestamp     = Get-Date -Format "yyyyMMdd-HHmmss"

function Invoke-Step([string]$Title, [scriptblock]$Action) {
    Write-Host ""
    Write-Host ("=" * 60) -ForegroundColor Cyan
    Write-Host " STEP: $Title" -ForegroundColor Cyan
    Write-Host ("=" * 60) -ForegroundColor Cyan
    try {
        & $Action
        Write-Host "  OK" -ForegroundColor Green
    } catch {
        Write-Host "  FAILED: $_" -ForegroundColor Red
        throw
    }
}

function Invoke-OpenClaw([string[]]$Args, [switch]$AllowNonZero) {
    Write-Host "  > openclaw $($Args -join ' ')" -ForegroundColor DarkGray
    $result = & openclaw @Args 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    Write-Host $result.TrimEnd()
    if (-not $AllowNonZero -and $exitCode -ne 0) {
        throw "openclaw $($Args[0]) exited with code $exitCode"
    }
    return $result.Trim()
}

function New-Backup([string]$Path) {
    if (Test-Path $Path) {
        $bak = "$Path.bak-trae-bridge-$Timestamp"
        Copy-Item $Path $bak -Force
        Write-Host "  backup: $bak" -ForegroundColor Yellow
        return $bak
    }
    return $null
}

Write-Host ""
Write-Host "Trae <=> OpenClaw — OpenClaw side deploy" -ForegroundColor Magenta
Write-Host "  Plugin src:   $PluginSrc"
Write-Host "  Dest:         $DestDir"
Write-Host ""

# --- Step 1: 直接复制插件到 extensions/trae/ ---
Invoke-Step "Copy plugin to global extensions/trae/" {
    if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    Copy-Item -Path "$PluginSrc\*" -Destination $DestDir -Recurse -Force
    # 清理 tgz 和测试文件
    Get-ChildItem $DestDir -Filter "*.tgz" | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem $DestDir -Filter "test-*.mjs" -File | Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Host "  -> $DestDir"
    Get-ChildItem $DestDir | Select-Object Name
}

# --- Step 2: 备份 openclaw.json ---
Invoke-Step "Backup openclaw.json" {
    New-Backup $ConfigFile
}

# --- Step 3: Patch config (enable trae + admin-http-rpc) ---
Invoke-Step "Enable plugins: trae + admin-http-rpc" {
    $patch = @'
{
  "plugins": {
    "entries": {
      "trae": { "enabled": true },
      "admin-http-rpc": { "enabled": true }
    }
  }
}
'@
    $patch | openclaw config patch --stdin 2>&1 | Out-Null
    Write-Host "  plugins.entries.trae / admin-http-rpc -> enabled: true"
}

# --- Step 3b: 把 trae 追加进 plugins.allow（读取本机已有列表后追加，不覆盖） ---
Invoke-Step "Append 'trae' to plugins.allow (if configured)" {
    $raw = (openclaw config get plugins.allow 2>&1 | Out-String).Trim()
    $current = @()
    if ($raw) {
        try { $current = @($raw | ConvertFrom-Json) } catch { $current = @() }
    }

    if ($current.Count -eq 0) {
        Write-Host "  plugins.allow not configured - nothing to do"
    } elseif ($current -contains "trae") {
        Write-Host "  'trae' already present"
    } else {
        $current += "trae"
        # PS 5.1 的 ConvertTo-Json 会展开单元素数组，这里手工拼 JSON
        $json = "[" + (($current | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ",") + "]"
        openclaw config set plugins.allow $json --strict-json 2>&1 | Out-Null
        Write-Host "  appended 'trae'"
    }
}

# --- Step 4: Enable chatCompletions endpoint ---
Invoke-Step "Enable chatCompletions HTTP endpoint" {
    openclaw config set gateway.http.endpoints.chatCompletions.enabled true --strict-json 2>&1 | Out-Null
    Write-Host "  gateway.http.endpoints.chatCompletions.enabled = true"
}

# --- Step 5: Restart gateway ---
Invoke-Step "Restart OpenClaw Gateway" {
    openclaw gateway restart 2>&1 | Out-Null
    Write-Host "  restart command sent"
    Write-Host "  waiting 10s for gateway..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 10
}

# --- Step 6: Health verify (node probe) ---
Invoke-Step "Verify 3 planes (node probe)" {
    $probe = Join-Path $RepoRoot "scripts\probe4.mjs"
    $env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
    node $probe 2>&1 | Select-Object -First 40
}

# --- Step 7: Ensure trae-bridge.json（已存在则不动，避免覆盖用户填过的 token） ---
Invoke-Step "Ensure trae-bridge.json template" {
    if (Test-Path $BridgeFile) {
        Write-Host "  exists, left untouched: $BridgeFile"
    } else {
        $tmpl = [ordered]@{
            gatewayUrl            = ""
            gatewayToken          = ""
            tlsRejectUnauthorized = $false
        }
        $tmpl | ConvertTo-Json | Set-Content -Path $BridgeFile -Encoding UTF8
        Write-Host "  -> $BridgeFile"
    }
}

Write-Host ""
Write-Host ("=" * 60) -ForegroundColor Green
Write-Host " OpenClaw-side deploy done" -ForegroundColor Green
Write-Host ("=" * 60) -ForegroundColor Green
Write-Host ""
Write-Host " Verify plugin loaded: openclaw gateway health" -ForegroundColor Cyan
Write-Host " OpenClaw side is ready. Next: deploy Trae side:" -ForegroundColor Cyan
Write-Host "   powershell -ExecutionPolicy Bypass -File scripts\deploy-trae.ps1" -ForegroundColor White
Write-Host ""

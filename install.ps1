param(
  [ValidateSet('install', 'uninstall', 'doctor')]
  [string]$Action = 'install',
  [switch]$Link
)

$ErrorActionPreference = 'Stop'

if ($env:AGY_TOKEN_METER_ACTION) {
  $Action = $env:AGY_TOKEN_METER_ACTION
}

$ArchiveUrl = if ($env:AGY_TOKEN_METER_ARCHIVE) {
  $env:AGY_TOKEN_METER_ARCHIVE
} else {
  'https://github.com/AnTengye/agy-token-meter/archive/refs/heads/main.zip'
}

$TargetDir = if ($env:AGY_PLUGIN_DIR) {
  $env:AGY_PLUGIN_DIR
} else {
  $geminiDir = Join-Path $HOME '.gemini'
  $cfgDir = Join-Path $geminiDir 'config'
  $pluginsRoot = Join-Path $cfgDir 'plugins'
  Join-Path $pluginsRoot 'token-meter'
}

$AppDataDir = if ($env:ANTIGRAVITY_APP_DATA_DIR) {
  $env:ANTIGRAVITY_APP_DATA_DIR
} else {
  $geminiDir = Join-Path $HOME '.gemini'
  Join-Path $geminiDir 'antigravity'
}

function Write-Log {
  param([string]$Message)
  Write-Host "[token-meter] $Message"
}

function Write-WarnLog {
  param([string]$Message)
  Write-Warning "[token-meter] $Message"
}

function Test-PluginSource {
  param([string]$Dir)
  if (-not $Dir) { return $false }
  $manifest = Join-Path $Dir 'plugin.json'
  $sidecarsDir = Join-Path $Dir 'sidecars'
  $meterDir = Join-Path $sidecarsDir 'meter'
  $mainFile = Join-Path $meterDir 'main.mjs'
  return (Test-Path -LiteralPath $manifest -PathType Leaf) -and (Test-Path -LiteralPath $mainFile -PathType Leaf)
}

function Resolve-LocalSource {
  if ($PSScriptRoot -and (Test-PluginSource $PSScriptRoot)) {
    return $PSScriptRoot
  }
  $cwd = (Get-Location).Path
  if (Test-PluginSource $cwd) {
    return $cwd
  }
  return $null
}

function Move-ExistingWithUnlock {
  param(
    [string]$Target,
    [string]$Backup
  )
  $pJson = Join-Path $Target 'plugin.json'
  $scDir = Join-Path $Target 'sidecars'
  $mDir = Join-Path $scDir 'meter'
  $scJson = Join-Path $mDir 'sidecar.json'
  Remove-Item -LiteralPath $pJson -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $scJson -Force -ErrorAction SilentlyContinue

  for ($i = 0; $i -lt 10; $i++) {
    try {
      if (Test-Path -LiteralPath $Backup) {
        Remove-Item -LiteralPath $Backup -Recurse -Force -ErrorAction SilentlyContinue
      }
      Move-Item -LiteralPath $Target -Destination $Backup -Force
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

function Invoke-Doctor {
  $ok = $true
  if (-not (Test-Path -LiteralPath $TargetDir)) {
    Write-WarnLog "Plugin is not installed at $TargetDir"
    return $false
  }

  $required = @(
    'plugin.json',
    (Join-Path 'assets' 'logo.svg'),
    (Join-Path (Join-Path 'skills' 'token-meter') 'SKILL.md'),
    (Join-Path (Join-Path 'sidecars' 'meter') 'package.json'),
    (Join-Path (Join-Path 'sidecars' 'meter') 'sidecar.json'),
    (Join-Path (Join-Path 'sidecars' 'meter') 'engine.mjs'),
    (Join-Path (Join-Path 'sidecars' 'meter') 'main.mjs'),
    (Join-Path (Join-Path 'sidecars' 'meter') 'index.html'),
    (Join-Path (Join-Path 'sidecars' 'meter') 'styles.css'),
    (Join-Path (Join-Path 'sidecars' 'meter') 'app.js')
  )

  foreach ($rel in $required) {
    $full = Join-Path $TargetDir $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      Write-WarnLog "Missing required file: $full"
      $ok = $false
    }
  }
  if ($ok) {
    Write-Log "Files OK: $TargetDir"
  }

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $nodeExe = $nodeCmd.Source
    & $nodeExe -e "import('node:sqlite').then(() => process.exit(0)).catch(() => process.exit(1))" 2>$null
    if ($LASTEXITCODE -eq 0) {
      Write-Log "Node SQLite runtime OK: $nodeExe"
      $mainScript = Join-Path (Join-Path (Join-Path $TargetDir 'sidecars') 'meter') 'main.mjs'
      $prevAppDir = $env:ANTIGRAVITY_APP_DATA_DIR
      try {
        $env:ANTIGRAVITY_APP_DATA_DIR = $AppDataDir
        $out = & $nodeExe $mainScript --overview today 2>&1
        if ($LASTEXITCODE -eq 0) {
          $joined = ($out -join ' ')
          if ($joined -match '"totals"\s*:\s*(\{[^}]*\})') {
            Write-Log "Engine read-only test OK: $($Matches[1])"
          } else {
            Write-Log 'Engine read-only test OK.'
          }
        } else {
          Write-WarnLog "Engine read-only test failed: $($out -join ' ')"
          $ok = $false
        }
      } finally {
        $env:ANTIGRAVITY_APP_DATA_DIR = $prevAppDir
      }
    } else {
      Write-WarnLog "Node found ($nodeExe) but does not support node:sqlite (requires Node >= 22.5)."
      $ok = $false
    }
  } else {
    Write-WarnLog 'Node.js not found in PATH; skipping CLI engine check (Antigravity uses its bundled runtime).'
  }

  $sidecarData = Join-Path $AppDataDir 'sidecar_data'
  $tmData = Join-Path $sidecarData 'token-meter'
  $mData = Join-Path $tmData 'meter'
  $logsDir = Join-Path $mData 'logs'
  $sidecarLog = Join-Path $logsDir 'sidecar.log'
  if (Test-Path -LiteralPath $sidecarLog -PathType Leaf) {
    $logText = Get-Content -LiteralPath $sidecarLog -Tail 30 -ErrorAction SilentlyContinue
    $port = $null
    foreach ($line in $logText) {
      if ($line -match '127\.0\.0\.1:(\d+)') {
        $port = $Matches[1]
      }
    }
    if ($port) {
      try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) {
          Write-Log "Sidecar HTTP server is LIVE on 127.0.0.1:$port"
        } else {
          Write-WarnLog "Sidecar port $port returned HTTP $($resp.StatusCode)"
        }
      } catch {
        Write-WarnLog "Last logged port $port is not responding right now (Antigravity may still be reloading)."
      }
    } else {
      Write-Log "Sidecar log present at $sidecarLog"
    }
  } else {
    Write-Log 'Sidecar log not found yet (Antigravity starts it automatically once enabled).'
  }

  return $ok
}

function Invoke-Install {
  $tmpDownload = $null
  $stageDir = $null
  try {
    $srcDir = Resolve-LocalSource
    if ($srcDir) {
      Write-Log "Using local source: $srcDir"
    } else {
      if ($Link) {
        throw '-Link requires running from a local repository clone.'
      }
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $tmpDownload = Join-Path ([System.IO.Path]::GetTempPath()) "agy-token-meter-$PID"
      New-Item -ItemType Directory -Path $tmpDownload -Force | Out-Null
      $zipPath = Join-Path $tmpDownload 'repo.zip'
      $extractDir = Join-Path $tmpDownload 'extract'
      Write-Log "Downloading $ArchiveUrl ..."
      Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zipPath -UseBasicParsing
      Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
      $candidates = @(Get-ChildItem -LiteralPath $extractDir -Directory)
      if ($candidates.Count -eq 0) {
        throw 'Downloaded archive extracted empty.'
      }
      $srcDir = $candidates[0].FullName
      if (-not (Test-PluginSource $srcDir)) {
        throw 'Downloaded archive does not contain plugin.json and sidecars/meter/main.mjs.'
      }
    }

    $pluginsDir = Split-Path -Path $TargetDir -Parent
    # Stage on the same volume outside plugins/ so Antigravity does not race and lock the staging dir.
    $stageRoot = Split-Path -Path $pluginsDir -Parent
    New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

    $backupDir = Join-Path $stageRoot ".token-meter-backup-$PID"

    if ($Link) {
      if (Test-Path -LiteralPath $TargetDir) {
        $item = Get-Item -LiteralPath $TargetDir -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
          Remove-Item -LiteralPath $TargetDir -Force
        } else {
          if (-not (Move-ExistingWithUnlock -Target $TargetDir -Backup $backupDir)) {
            throw "Failed to replace existing plugin directory at $TargetDir (in use)."
          }
          Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
      New-Item -ItemType SymbolicLink -Path $TargetDir -Target $srcDir | Out-Null
      Write-Log "Linked $TargetDir -> $srcDir"
    } else {
      $stageDir = Join-Path $stageRoot ".token-meter-stage-$PID"
      if (Test-Path -LiteralPath $stageDir) {
        Remove-Item -LiteralPath $stageDir -Recurse -Force
      }
      New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

      $filesToCopy = @('plugin.json', 'README.md', 'LICENSE', 'install.sh', 'install.ps1', 'install.mjs')
      foreach ($f in $filesToCopy) {
        $srcFile = Join-Path $srcDir $f
        if (Test-Path -LiteralPath $srcFile -PathType Leaf) {
          Copy-Item -LiteralPath $srcFile -Destination $stageDir -Force
        }
      }
      foreach ($d in @('assets', 'skills', 'sidecars')) {
        $srcSub = Join-Path $srcDir $d
        if (Test-Path -LiteralPath $srcSub -PathType Container) {
          Copy-Item -LiteralPath $srcSub -Destination $stageDir -Recurse -Force
        }
      }
      Get-ChildItem -Path $stageDir -Filter '.DS_Store' -Recurse -Force -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

      if (Test-Path -LiteralPath $TargetDir) {
        $item = Get-Item -LiteralPath $TargetDir -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
          Remove-Item -LiteralPath $TargetDir -Force
        } else {
          if (-not (Move-ExistingWithUnlock -Target $TargetDir -Backup $backupDir)) {
            throw "Failed to move existing $TargetDir to backup (directory in use)."
          }
        }
      }

      try {
        Move-Item -LiteralPath $stageDir -Destination $TargetDir -Force
        $stageDir = $null
        if (Test-Path -LiteralPath $backupDir) {
          Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
        }
      } catch {
        if ((Test-Path -LiteralPath $backupDir) -and -not (Test-Path -LiteralPath $TargetDir)) {
          Move-Item -LiteralPath $backupDir -Destination $TargetDir -Force -ErrorAction SilentlyContinue
        }
        throw
      }
      Write-Log "Installed atomically to $TargetDir"
    }

    Write-Log 'Note: ~/.gemini/config/config.json was not modified; Antigravity 2.0 hot-loads plugins automatically.'
    [void](Invoke-Doctor)
  } finally {
    if ($tmpDownload -and (Test-Path -LiteralPath $tmpDownload)) {
      Remove-Item -LiteralPath $tmpDownload -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($stageDir -and (Test-Path -LiteralPath $stageDir)) {
      Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-Uninstall {
  if (-not $TargetDir -or $TargetDir -eq '/' -or $TargetDir -match '^[A-Za-z]:\\?$') {
    throw "Unsafe TargetDir: $TargetDir"
  }
  if (-not (Test-Path -LiteralPath $TargetDir)) {
    Write-Log "Nothing to remove ($TargetDir does not exist)."
    return
  }
  $item = Get-Item -LiteralPath $TargetDir -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Remove-Item -LiteralPath $TargetDir -Force
  } else {
    $pluginsDir = Split-Path -Path $TargetDir -Parent
    $stageRoot = Split-Path -Path $pluginsDir -Parent
    $backupDir = Join-Path $stageRoot ".token-meter-uninstall-$PID"
    if (Move-ExistingWithUnlock -Target $TargetDir -Backup $backupDir) {
      Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Remove-Item -LiteralPath $TargetDir -Recurse -Force
    }
  }
  Write-Log "Removed $TargetDir"
}

switch ($Action) {
  'install'   { Invoke-Install }
  'uninstall' { Invoke-Uninstall }
  'doctor'    {
    $ok = Invoke-Doctor
    if (-not $ok) { exit 1 }
  }
}

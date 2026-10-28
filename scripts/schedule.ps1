<#
.SYNOPSIS
  把 TapTap 答疑守护做成「登录即启动、崩溃自动重启」的计划任务（Windows）。

.DESCRIPTION
  为什么不是 Windows 服务？
    Windows 服务跑在 Session 0（隔离会话），看不到你桌面上已登录的 Chrome，
    而本工具的回复完全依赖操作真实的、已登录 TapTap 的浏览器窗口。
    → 只能做成「用户登录时运行」的计划任务。

  前提：
    1) 本机已装 opencli + 浏览器扩展，Chrome 已登录 TapTap（opencli doctor 全绿）
    2) config.json 的 myUserId 已填
    3) 机器保持登录状态（锁屏可以，注销/关机不行 —— 注销就没有桌面会话了）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action install
  powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action status
  powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action doctor
  powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action uninstall
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status', 'doctor', 'start', 'stop')]
  [string]$Action = 'status',

  [string]$TaskName = 'TapTap-PVZ2-答疑守护',

  # 登录后延迟启动，等 Chrome / opencli daemon 起来
  [int]$DelayMinutes = 2,

  # 崩溃后重启次数与间隔
  [int]$RestartCount = 999,
  [int]$RestartMinutes = 1
)

$ErrorActionPreference = 'Stop'

$Skill   = Split-Path $PSScriptRoot -Parent          # scripts\ 的上一级 = skill 根目录
$Launcher = Join-Path $PSScriptRoot 'run-watch.cmd'
$LogFile  = Join-Path $Skill 'logs\watch.log'

function Write-Head($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Write-Warn2($t){ Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Write-Err2($t) { Write-Host "  [X]  $t" -ForegroundColor Red }

function Resolve-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Show-Status {
  Write-Head "计划任务状态"
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Warn2 "任务「$TaskName」未安装。装：-Action install"
  } else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Ok "已安装：$TaskName（状态 $($task.State)）"
    Write-Host ("     上次运行：{0}   结果：0x{1:X}   下次运行：{2}" -f $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime)
    Write-Host ("     触发器：{0}" -f (($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', '))
  }

  Write-Head "进程"
  # 只认「命令行以 watch.mjs 结尾」的 node 进程。
  # 别用 -like '*watch.mjs*'：查询命令/DSH 包装进程的命令行里也含这个字样，会误报多个守护。
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'watch\.mjs"?\s*$' -and $_.CommandLine -notmatch 'runner\.js|Get-CimInstance' }
  if ($procs) {
    $procs | ForEach-Object { Write-Ok "watch.mjs 正在运行 PID=$($_.ProcessId)" }
    if (($procs | Measure-Object).Count -gt 1) {
      Write-Err2 "发现多个 watch.mjs 同时在跑！会重复回复，请只保留一个"
    }
  } else {
    Write-Warn2 "没有发现运行中的 watch.mjs"
  }

  Write-Head "日志（最后 20 行）"
  if (Test-Path $LogFile) {
    Get-Content $LogFile -Tail 20 -Encoding UTF8
  } else {
    Write-Warn2 "还没有日志：$LogFile"
  }
}

function Show-Doctor {
  Write-Head "自检"
  $node = Resolve-Node
  if ($node) { Write-Ok "node：$node" } else { Write-Err2 "找不到 node.exe" }

  $cfgPath = Join-Path $PSScriptRoot 'config.json'
  if (Test-Path $cfgPath) {
    try {
      $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ([string]::IsNullOrWhiteSpace($cfg.myUserId)) {
        Write-Err2 "config.json 里 myUserId 是空的 → 判断不了「我回过没」，会重复回"
      } else {
        Write-Ok "myUserId = $($cfg.myUserId)"
      }
      Write-Host ("     dryRun = {0}（false 才会真发）" -f $cfg.reply.dryRun)
      Write-Host ("     appId/groupId = {0}/{1}" -f $cfg.appId, $cfg.groupId)
    } catch { Write-Err2 "config.json 解析失败：$($_.Exception.Message)" }
  } else { Write-Err2 "找不到 config.json" }

  foreach ($f in @('scripts\watch.mjs', 'scripts\run-watch.cmd', 'qa\答疑库.md')) {
    if (Test-Path (Join-Path $Skill $f)) { Write-Ok "存在：$f" } else { Write-Err2 "缺失：$f" }
  }

  Write-Head "opencli"
  $oc = Get-Command opencli -ErrorAction SilentlyContinue
  if ($oc) {
    # opencli 正常退出码可能非 0（会打印「有新版本」），这里临时放开 Stop 以免抛异常
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = (& opencli doctor 2>&1 | Out-String)
    } catch {
      $out = "执行失败：$($_.Exception.Message)"
    } finally {
      $ErrorActionPreference = $prev
    }
    if ($out -match 'Extension:\s*connected') { Write-Ok 'opencli 扩展已连接' }
    else {
      Write-Warn2 '扩展可能未连接，输出如下：'
      Write-Host ($out.Trim() | Select-Object -First 1)
      ($out -split "`n" | Select-Object -First 12) | ForEach-Object { Write-Host "     $_" }
    }
  } else {
    Write-Warn2 '没装 opencli：npm i -g @jackwener/opencli'
  }

  Write-Head "浏览器登录态提醒"
  Write-Host '  opencli 驱动的是你桌面上那个 Chrome。要求：'
  Write-Host '    · Chrome 已登录 www.taptap.cn'
  Write-Host '    · 机器保持登录（锁屏 OK，注销/关机不行）'
  Write-Host '    · 不要用「服务」方式运行（Session 0 看不到桌面 Chrome）'
}

function Install-Task {
  Write-Head "安装计划任务"

  if (-not (Test-Path $Launcher)) { throw "找不到启动器：$Launcher" }
  $node = Resolve-Node
  if (-not $node) { throw "找不到 node.exe，请先安装 Node.js" }
  # 把 node 绝对路径固定下来：计划任务的环境变量可能不完整
  Set-Content -Path (Join-Path $PSScriptRoot 'node-path.txt') -Value $node -Encoding ASCII
  Write-Ok "node 路径已固化：$node"

  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Warn2 "已存在同名任务，先卸载旧的"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }

  $action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument ('/c ""{0}""' -f $Launcher) `
    -WorkingDirectory $Skill

  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  try { $trigger.Delay = "PT$($DelayMinutes)M" } catch { Write-Warn2 "设置延迟失败，将立即启动" }

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount $RestartCount -RestartInterval (New-TimeSpan -Minutes $RestartMinutes) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

  # Interactive = 只在用户登录时运行（必须有桌面会话才能操作 Chrome）
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'TapTap 植物大战僵尸2 论坛答疑守护：每 10 分钟抓最新帖、答疑、夸答题玩家' | Out-Null

  Write-Ok "已注册：$TaskName（登录后 $DelayMinutes 分钟启动，崩溃每 $RestartMinutes 分钟重启）"
  Write-Host "`n  立即试跑一次：powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action start"
  Write-Host "  看状态：      powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action status"
  Write-Host "  日志：        $LogFile"
}

function Uninstall-Task {
  Write-Head "卸载计划任务"
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Warn2 "任务不存在，跳过"; return }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Ok "已卸载：$TaskName"
  Write-Host "  （data\state.json、qa\答疑库.md 都保留，不会被删）"
}

switch ($Action) {
  'install'   { Install-Task }
  'uninstall' { Uninstall-Task }
  'start'     {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { throw "任务未安装，先 -Action install" }
    Start-ScheduledTask -TaskName $TaskName
    Write-Ok "已启动：$TaskName"
    Start-Sleep -Seconds 3
    Show-Status
  }
  'stop'      {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Ok "已停止：$TaskName"
  }
  'status'    { Show-Status }
  'doctor'    { Show-Doctor; Show-Status }
}

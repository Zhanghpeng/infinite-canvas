@echo off
REM ============================================================
REM  Infinite Canvas 一键启动（Windows）
REM
REM  双击运行，会按需在独立窗口里启动三个服务：
REM    1) local-workspace  -> http://127.0.0.1:17400  本地工作区文件服务（本地存储模式用）
REM    2) canvas-agent     -> http://127.0.0.1:17371  本地 Agent 服务
REM    3) web (Vite)       -> http://localhost:3000   画布前端
REM
REM  关掉某个窗口即停掉对应服务。
REM
REM  说明：
REM   - 路径全部相对本脚本所在目录，仓库换盘符/换机器都不用改。
REM   - canvas-agent 与 local-workspace 需要各自装过依赖（scripts/setup.sh 或 npm install），
REM     缺失时会跳过并提示，不影响前端启动。
REM   - local-workspace 的连接 token 在 %USERPROFILE%\.infinite-canvas\local-workspace.json，
REM     启动后窗口里也会直接打印。
REM ============================================================

setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 没找到 node，请先安装 Node.js 18 以上版本。
    pause
    exit /b 1
)

echo ============================================
echo  Infinite Canvas 启动中
echo  仓库：%ROOT%
echo ============================================

REM ---- 1) 本地工作区服务 ----
if exist "%ROOT%\local-workspace\node_modules" (
    start "LocalWorkspace" cmd /k "cd /d ""%ROOT%\local-workspace"" && node index.js"
) else (
    echo [跳过] local-workspace 未安装依赖：cd local-workspace ^&^& npm install
)

REM ---- 2) 本地 Agent ----
if exist "%ROOT%\canvas-agent\node_modules" (
    start "CanvasAgent" cmd /k "cd /d ""%ROOT%\canvas-agent"" && npm run dev"
) else (
    echo [跳过] canvas-agent 未安装依赖：cd canvas-agent ^&^& npm install
)

REM ---- 3) 前端 ----
if exist "%ROOT%\web\node_modules" (
    start "CanvasWeb" cmd /k "cd /d ""%ROOT%\web"" && npm run dev"
) else (
    echo [错误] web 未安装依赖：cd web ^&^& npm install
    pause
    exit /b 1
)

echo.
echo  画布：   http://localhost:3000/
echo  本地服务：http://127.0.0.1:17400/health
echo  Agent：  http://127.0.0.1:17371
echo.
echo  本窗口可以关闭，各服务在各自窗口里运行。
pause

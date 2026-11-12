# 三端独立 App 批量构建：四级 / 六级 / 考研
$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME = 'C:\Android\Sdk'
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\build-tools\34.0.0;$env:PATH"

$ROOT = 'C:\Users\Administrator\Desktop\cet-practice'
$FE = Join-Path $ROOT 'frontend'
$PY = 'C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe'
$GRADLE = Join-Path $FE 'android\app\build.gradle'
$STRINGS = Join-Path $FE 'android\app\src\main\res\values\strings.xml'
$CAPCFG = Join-Path $FE 'capacitor.config.ts'

# 基线快照（仅首次）
foreach ($p in @($GRADLE, $STRINGS, $CAPCFG)) {
    $b = "$p.baseline"
    if (-not (Test-Path $b)) { Copy-Item $p $b -Force }
}

$configs = @(
    @{ exam = 'cet4';   name = '四级研习社'; mark = '四'; sub = 'CET-4 真题 · 离线速练'; slogan = '四级真题，一套一套吃透。'; quote = '积跬步，至千里。'; pkg = 'com.zhenti.cet4';   ver = '2.0.0'; code = 2; color = '2563EB'; out = 'CET4-四级研习社-v2.0.0.apk' },
    @{ exam = 'cet6';   name = '六级研习社'; mark = '六'; sub = 'CET-6 真题 · 离线速练'; slogan = '六级真题，步步为营。';   quote = '每一步，都算数。'; pkg = 'com.zhenti.cet6';   ver = '2.0.0'; code = 2; color = '7C3AED'; out = 'CET6-六级研习社-v2.0.0.apk' },
    @{ exam = 'kaoyan'; name = '考研研习社'; mark = '研'; sub = '考研英语 · 离线速练'; slogan = '考研英语，稳扎稳打。';   quote = '日拱一卒，功不唐捐。'; pkg = 'com.zhenti.kaoyan'; ver = '2.0.0'; code = 2; color = '059669'; out = '考研研习社-v2.0.0.apk' }
)

foreach ($c in $configs) {
    Write-Host "`n================ $($c.exam) : $($c.name) ================"
    # 1) 子集化数据 + 品牌 env
    & $PY (Join-Path $ROOT 'scripts\prepare_variant.py') $c.exam "name=$($c.name)" "mark=$($c.mark)" "sub=$($c.sub)" "slogan=$($c.slogan)" "quote=$($c.quote)" "version=v$($c.ver)"
    if ($LASTEXITCODE -ne 0) { throw "prepare_variant 失败: $($c.exam)" }

    # 2) 图标
    & $PY (Join-Path $ROOT 'scripts\make_icon.py') $c.mark $c.color
    if ($LASTEXITCODE -ne 0) { throw "make_icon 失败: $($c.exam)" }

    # 3) 前端构建
    Push-Location $FE
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm build 失败: $($c.exam)" }
    npx.cmd cap sync android
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cap sync 失败: $($c.exam)" }
    Pop-Location

    # 4) 恢复基线后 patch 包名/版本 + 应用名
    Copy-Item "$GRADLE.baseline" $GRADLE -Force
    $g = Get-Content $GRADLE -Raw -Encoding UTF8
    $g = $g -replace 'applicationId "com\.englishstudy\.cet"', "applicationId `"$($c.pkg)`""
    $g = $g -replace 'versionCode 1', "versionCode $($c.code)"
    $g = $g -replace 'versionName "1\.0"', "versionName `"$($c.ver)`""
    Set-Content $GRADLE $g -Encoding UTF8 -NoNewline

    Copy-Item "$STRINGS.baseline" $STRINGS -Force
    $s = Get-Content $STRINGS -Raw -Encoding UTF8
    $s = $s -replace '<string name="app_name">.*?</string>', "<string name=`"app_name`">$($c.name)</string>"
    $s = $s -replace '<string name="title_activity_main">.*?</string>', "<string name=`"title_activity_main`">$($c.name)</string>"
    $s = $s -replace '<string name="package_name">.*?</string>', "<string name=`"package_name`">$($c.pkg)</string>"
    $s = $s -replace '<string name="custom_url_scheme">.*?</string>', "<string name=`"custom_url_scheme`">$($c.pkg)</string>"
    Set-Content $STRINGS $s -Encoding UTF8 -NoNewline

    Copy-Item "$CAPCFG.baseline" $CAPCFG -Force
    $cap = Get-Content $CAPCFG -Raw -Encoding UTF8
    $cap = $cap -replace "appId:\s*'[^']*'", "appId: '$($c.pkg)'"
    $cap = $cap -replace "appName:\s*'[^']*'", "appName: '$($c.name)'"
    Set-Content $CAPCFG $cap -Encoding UTF8 -NoNewline

    # 5) 打包 release
    Push-Location (Join-Path $FE 'android')
    .\gradlew.bat assembleRelease -q
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "gradlew 失败: $($c.exam)" }
    Pop-Location

    $apk = Join-Path $FE 'android\app\build\outputs\apk\release\app-release.apk'
    $dest = Join-Path 'C:\Users\Administrator\Desktop' $c.out
    Copy-Item $apk $dest -Force
    $mb = [math]::Round((Get-Item $apk).Length / 1MB, 1)
    Write-Host "[OK] $($c.exam) -> $dest ($mb MB)"
}

Write-Host "`n============ 全部完成 ============"

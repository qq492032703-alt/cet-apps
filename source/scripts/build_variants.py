# -*- coding: utf-8 -*-
"""三端独立 App 批量构建（四级/六级/考研）。用 Python 编排，避免 PowerShell 的编码坑。"""
import os, sys, re, shutil, subprocess

ROOT = r'C:\Users\Administrator\Desktop\cet-practice'
FE = os.path.join(ROOT, 'frontend')
AND = os.path.join(FE, 'android')
PY = r'C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe'
GRADLE = os.path.join(AND, 'app', 'build.gradle')
STRINGS = os.path.join(AND, 'app', 'src', 'main', 'res', 'values', 'strings.xml')
CAPCFG = os.path.join(FE, 'capacitor.config.ts')
DESK = r'C:\Users\Administrator\Desktop'

env = dict(os.environ)
env['JAVA_HOME'] = r'C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
env['ANDROID_HOME'] = r'C:\Android\Sdk'
env['PATH'] = (env['JAVA_HOME'] + r'\bin;' + env['ANDROID_HOME'] + r'\platform-tools;'
               + env['ANDROID_HOME'] + r'\build-tools\34.0.0;' + env.get('PATH', ''))

BASE = os.path.join(ROOT, 'build-input', 'variant-baseline')
os.makedirs(BASE, exist_ok=True)
B_GRADLE = os.path.join(BASE, 'build.gradle.baseline')
B_STRINGS = os.path.join(BASE, 'strings.xml.baseline')
B_CAP = os.path.join(BASE, 'capacitor.config.ts.baseline')
for p, b in ((GRADLE, B_GRADLE), (STRINGS, B_STRINGS), (CAPCFG, B_CAP)):
    if not os.path.exists(b):
        shutil.copy2(p, b)

def read(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()

def write(p, s):
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(s)

def run_list(args, cwd=None):
    print('>>', args)
    r = subprocess.run(args, cwd=cwd, env=env)
    if r.returncode != 0:
        raise SystemExit('FAILED: ' + ' '.join(args))

def run_shell(cmd, cwd=None):
    print('>>', cmd)
    r = subprocess.run(cmd, cwd=cwd, env=env, shell=True)
    if r.returncode != 0:
        raise SystemExit('FAILED: ' + cmd)

CONFIGS = [
    dict(exam='cet4',   name='四级研习社', mark='四', sub='CET-4 真题 · 离线速练', slogan='四级真题，一套一套吃透。', quote='积跬步，至千里。', pkg='com.zhenti.cet4',   ver='2.0.0', code=2, color='2563EB', out='CET4-四级研习社-v2.0.0.apk'),
    dict(exam='cet6',   name='六级研习社', mark='六', sub='CET-6 真题 · 离线速练', slogan='六级真题，步步为营。',   quote='每一步，都算数。', pkg='com.zhenti.cet6',   ver='2.0.0', code=2, color='7C3AED', out='CET6-六级研习社-v2.0.0.apk'),
    dict(exam='kaoyan', name='考研研习社', mark='研', sub='考研英语 · 离线速练', slogan='考研英语，稳扎稳打。',   quote='日拱一卒，功不唐捐。', pkg='com.zhenti.kaoyan', ver='2.0.0', code=2, color='059669', out='考研研习社-v2.0.0.apk'),
]

for c in CONFIGS:
    print('=' * 24, c['exam'], c['name'], '=' * 24)
    run_list([PY, os.path.join(ROOT, 'scripts', 'prepare_variant.py'), c['exam'],
              'name=' + c['name'], 'mark=' + c['mark'], 'sub=' + c['sub'],
              'slogan=' + c['slogan'], 'quote=' + c['quote'], 'version=v' + c['ver']])
    run_list([PY, os.path.join(ROOT, 'scripts', 'make_icon.py'), c['mark'], c['color']])
    run_shell('npm.cmd run build', cwd=FE)
    run_shell('npx.cmd cap sync android', cwd=FE)

    g = read(B_GRADLE)
    g = g.replace('applicationId "com.englishstudy.cet"', 'applicationId "%s"' % c['pkg'])
    g = g.replace('versionCode 1', 'versionCode %d' % c['code'])
    g = g.replace('versionName "1.0"', 'versionName "%s"' % c['ver'])
    write(GRADLE, g)

    s = read(B_STRINGS)
    s = re.sub(r'<string name="app_name">.*?</string>', '<string name="app_name">%s</string>' % c['name'], s)
    s = re.sub(r'<string name="title_activity_main">.*?</string>', '<string name="title_activity_main">%s</string>' % c['name'], s)
    s = re.sub(r'<string name="package_name">.*?</string>', '<string name="package_name">%s</string>' % c['pkg'], s)
    s = re.sub(r'<string name="custom_url_scheme">.*?</string>', '<string name="custom_url_scheme">%s</string>' % c['pkg'], s)
    write(STRINGS, s)

    cap = read(B_CAP)
    cap = re.sub(r"appId:\s*'[^']*'", "appId: '%s'" % c['pkg'], cap)
    cap = re.sub(r"appName:\s*'[^']*'", "appName: '%s'" % c['name'], cap)
    write(CAPCFG, cap)

    run_shell('gradlew.bat assembleRelease', cwd=AND)
    apk = os.path.join(AND, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
    dest = os.path.join(DESK, c['out'])
    shutil.copy2(apk, dest)
    print('[OK]', c['exam'], '->', dest, round(os.path.getsize(apk) / 1048576, 1), 'MB')

print('ALL DONE')

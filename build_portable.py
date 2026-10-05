"""Build self-contained share/private HTML files without bundler dependencies."""
from __future__ import annotations

import argparse
import base64
import io
import json
import re
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent
REPOSITORY = 'https://github.com/wssz527/ModelTrace-Portable'


def script_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def public_bank(bank: dict) -> dict:
    from fingerprint_policy import filter_disabled_bank

    bank = filter_disabled_bank(bank)
    return {
        "models": [
            {key: model[key] for key in ("id", "display_name", "family", "family_name", "response_count", "valid_number_count", "counts") if key in model}
            for model in bank["models"]
        ],
        "robust": {
            name: {key: value for key, value in artifact.items() if key in ("feature_mean", "feature_scale", "centroids", "nuisance_basis", "weight", "environment_centroids")}
            for name, artifact in bank["robust"].items() if name in ("hellinger", "ordered_blocks")
        },
        "calibration": {key: {field: value for field, value in item.items() if field in ("beta", "cv_accuracy")} for key, item in bank["calibration"].items()},
    }


LIBRARY = '''<section id="workspace-library" class="workspace">
  <div class="page-header"><h1>指纹库与数据</h1><span class="privacy-badge">浏览器本地计算</span></div>
  <section class="form-panel portable-panel">
    <h2>指纹库</h2><p id="portable-bank-summary"></p>
    <div class="portable-actions"><button id="update-bank" type="button" class="button primary">拉取最新指纹库</button><button id="save-html" type="button" class="button secondary">保存到当前 HTML</button></div>
    <p id="upstream-status" role="status" hidden></p><p id="save-status" role="status" hidden></p>
    <details class="upstream-settings"><summary>更新设置</summary><label>上游地址<input id="upstream-url" type="url" value="https://raw.githubusercontent.com/xqy2006/ModelTrace/main/static/data/unified_bank.json" spellcheck="false"></label></details>
    <div class="portable-actions"><button id="export-bank" type="button" class="button secondary">导出指纹库</button><label class="button secondary" for="import-bank">导入完整指纹库 JSON</label><input id="import-bank" type="file" accept=".json,application/json" hidden><button id="restore-bank" type="button" class="button secondary">恢复内置指纹库</button></div>
    <div id="portable-bank-models" class="portable-models"></div><p id="bank-message" role="status"></p>
  </section>
  <section class="form-panel portable-panel"><h2>数据管理</h2><div class="portable-actions"><button id="download-share" type="button" class="button primary">导出分享版 HTML</button><button id="clear-private-data" type="button" class="button secondary">清除本机提供商配置</button></div></section>
  <section class="form-panel portable-panel"><h2>项目与上游</h2><p>基于 ModelTrace 改进的便携版本。算法与原始指纹库来自上游项目。</p><div class="portable-actions"><a class="button secondary" href="https://github.com/wssz527/ModelTrace-Portable" target="_blank" rel="noopener noreferrer">本项目 GitHub</a><a class="button secondary" href="https://github.com/xqy2006/ModelTrace" target="_blank" rel="noopener noreferrer">上游项目</a><a class="button secondary" href="https://xqy2006.github.io/ModelTrace/" target="_blank" rel="noopener noreferrer">上游指纹浏览与测试</a><a class="button secondary" href="https://github.com/wssz527/ModelTrace-Portable#readme" target="_blank" rel="noopener noreferrer">完整使用说明</a></div></section>
</section>'''

GUIDE = '''<section id="quick-start" class="form-panel portable-panel quick-start" hidden>
  <div class="guide-heading"><h2>先选一种使用方式</h2><button id="close-guide" type="button" class="button secondary">收起引导</button></div>
  <div class="guide-columns"><div><h3>API 自动测试</h3><p>填写 Base URL 和 API Key → 拉取模型 → 勾选模型 → 开始测试。</p><button id="guide-api" type="button" class="button primary">填写接口</button></div><div><h3>手动粘贴</h3><p>生成挑战 → 复制提示词 → 粘贴完整回答 → 计算归因。</p><button id="guide-manual" type="button" class="button secondary">使用手动粘贴</button></div></div>
  <details><summary>更新与分享</summary><p>更新：指纹库与数据 → 拉取最新指纹库。分享：指纹库与数据 → 导出分享版 HTML。</p></details>
</section>'''

EXTENSION_SETUP = '''<dialog id="extension-help" class="extension-setup" aria-labelledby="extension-title" hidden>
  <div class="guide-heading"><h2 id="extension-title">安装连接扩展</h2><button id="extension-close" type="button" class="button secondary">关闭</button></div>
  <ol class="extension-steps">
    <li><span>下载扩展并解压到固定文件夹。</span><button id="extension-download" type="button" class="button primary">下载扩展</button></li>
    <li><span>在浏览器地址栏打开扩展管理页。</span><div class="extension-manager"><select id="extension-browser" aria-label="浏览器"><option value="edge">Edge</option><option value="chrome">Chrome</option></select><input id="extension-manager-url" aria-label="扩展管理页地址" readonly value="edge://extensions"><button id="extension-copy" type="button" class="button secondary">复制地址</button></div></li>
    <li>开启“开发人员模式” → 点击“加载解压缩的扩展” → 选择 <strong>ModelTrace-连接扩展</strong> 文件夹。</li>
    <li>打开扩展详情 → 开启“允许访问文件网址”。</li>
    <li>在同一个浏览器中刷新本 HTML → 点击“检测并继续”。</li>
  </ol>
  <p id="extension-setup-status" role="status" aria-live="polite">等待安装</p>
  <div class="portable-actions"><button id="extension-check" type="button" class="button primary">检测并继续</button></div>
</dialog>'''

CSS = '''
[hidden] { display: none !important; }
.portable-notice { padding: 12px 16px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 16px; background: var(--surface); color: var(--muted); font-size: 12px; line-height: 1.7; }
.portable-notice.private { background: var(--warning-soft); color: var(--warning); border-color: #eedca6; }
.portable-panel { padding: 20px; margin-bottom: 16px; }
.portable-panel h2 { font-size: 16px; margin: 0 0 12px; }
.portable-panel p { line-height: 1.8; color: var(--muted); }
.portable-actions, .connection-extras { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.connection-extras { padding: 0 17px 15px; font-size: 12px; color: var(--muted); }
.connection-extras label { display: flex; flex-direction: row; align-items: center; gap: 6px; }
.connection-extras input[type=checkbox] { width: auto; height: auto; }
.connection-extras select { padding: 7px; border: 1px solid var(--line); border-radius: 5px; }
.portable-models { display: grid; grid-template-columns: repeat(auto-fill, minmax(235px,1fr)); gap: 8px; margin-top: 18px; }
.portable-model { padding: 10px; font-size: 12px; background: var(--surface-soft); border: 1px solid var(--line); border-radius: 6px; overflow-wrap: anywhere; }
.upstream-settings { margin: 16px 0; font-size: 12px; color: var(--muted); }
.upstream-settings label { margin-top: 10px; }
.upstream-settings input { width: 100%; }
.guide-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.guide-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.guide-columns h3 { font-size: 14px; margin-bottom: 6px; }
.quick-start details { margin-top: 18px; color: var(--muted); font-size: 12px; }
.extension-setup { box-sizing: border-box; width: min(590px, calc(100vw - 24px)); max-height: calc(100vh - 40px); overflow: auto; padding: 24px; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 18px 60px #14213c35; }
.extension-setup::backdrop { background: #14213c88; }
.extension-setup h2 { margin: 0; font-size: 18px; }
.extension-setup .guide-heading button { width: auto; flex: none; }
.extension-steps { padding-left: 24px; margin: 24px 0 18px; }
.extension-steps li { padding-left: 4px; margin: 16px 0; font-size: 13px; line-height: 1.8; }
.extension-steps li > button { display: block; margin-top: 8px; }
.extension-manager { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.extension-manager input { flex: 1; min-width: 170px; width: auto; }
.extension-manager select { padding: 8px; border: 1px solid var(--line); border-radius: 5px; }
#extension-setup-status { font-size: 13px; line-height: 1.7; color: var(--muted); }
.conn-grid { grid-template-columns: 1fr 1.5fr 1.2fr; }
.conn-actions { flex-wrap: wrap; }
.model-check-item { flex-direction: row !important; }
.picker-manual { flex-wrap: wrap; }
.challenge-header button { margin-left: auto; }
.card-top-item { grid-template-columns: minmax(0, 1fr) 90px 50px; }
.test-card-head { flex-wrap: wrap; }
.test-card-model { white-space: normal; overflow-wrap: anywhere; }
.round-state { overflow-wrap: anywhere; min-width: 0; }
.round-row { flex-wrap: wrap; }
.version { white-space: nowrap; }
@media (max-width: 700px) {
  .topbar { padding: 0 12px; height: auto; min-height: 58px; flex-wrap: wrap; gap: 8px; }
  .version { display: none; }
  .layout { display: block; }
  .sidebar { position: static; height: auto; padding: 10px; border-right: 0; }
  .sidebar nav { grid-template-columns: 1fr 1fr; }
  .sidebar-note { display: none; }
  .main-content { padding: 18px 12px 40px; }
  .page-header { gap: 8px; flex-wrap: wrap; }
  .conn-grid { grid-template-columns: 1fr; }
  .conn-actions { align-items: center; }
  .mode-tabs { display: flex; }
  .mode-tab { min-width: 0; flex: 1; padding: 8px 6px; }
  .picker-toolbar { flex-wrap: wrap; }
  .picker-toolbar input[type=search] { max-width: none; flex-basis: 100%; }
  .challenge-columns, .round-io { grid-template-columns: 1fr; }
  .result-summary { grid-template-columns: 1fr 1fr; }
  .stability-toolbar { align-items: flex-start; gap: 12px; }
  .stability-config { flex-wrap: wrap; }
  .provider-save-row { flex-wrap: wrap; }
  .guide-columns { grid-template-columns: 1fr; gap: 12px; }
}
'''


def build(destination: Path, private_providers: list[dict] | None = None) -> None:
    private = private_providers is not None
    providers = private_providers or []
    template = (PROJECT / "templates/index.html").read_text(encoding="utf-8")
    license_text = (PROJECT / "LICENSE").read_text(encoding="utf-8")
    template = template.replace('<head>', '<head>\n<!--\n' + license_text + '\n-->')
    css = "\n".join((PROJECT / "static" / name).read_text(encoding="utf-8") for name in ("styles.css", "repository-link.css", "studio.css")) + CSS
    template = re.sub(r'  <link rel="stylesheet"[^\n]+\n', '', template)
    template = template.replace('</head>', '<link rel="icon" href="data:,">\n<style>' + css + '</style>\n</head>')
    template = template.replace('<title>ModelTrace</title>', '<title>ModelTrace · ' + ('私人测试版' if private else '便携分享版') + '</title>')
    template = template.replace('自动化测试台</span>', '便携版</span>')
    template = template.replace('href="https://github.com/xqy2006/ModelTrace"', 'href="' + REPOSITORY + '"', 1)
    template = template.replace('<div class="topbar-status">', '<button id="open-guide" type="button" class="button secondary">使用指南</button><div class="topbar-status">', 1)
    template = template.replace('</div>\n    </header>', '<button id="theme-toggle" type="button" title="切换主题">🌙</button></div>\n    </header>', 1)
    template = template.replace('{{ unified.model_count }}', '17')
    template = template.replace('自动更新 · 手动维护', '本地指纹 · 导入与导出')
    template = re.sub(r'      <div class="sidebar-note">.*?</div>\n', '', template)
    template = template.replace('placeholder="选择提供商自动填入"', 'placeholder="临时填写或选择提供商"')
    start = template.index('      <section id="workspace-library"')
    end = template.index('\n    </main>', start)
    template = template[:start] + LIBRARY + template[end:]
    end = template.index('  <datalist id="model-options">')
    template = template[:end]
    extras = '''<div class="connection-extras"><label>接口格式 <select id="conn-format"><option value="auto">自动识别</option><option value="openai">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option></select></label><button id="conn-key-toggle" type="button" class="button secondary">显示密钥</button><label><input id="remember-key" type="checkbox"> 在本机记住密钥</label><button id="extension-setup-open" type="button" class="button secondary" hidden>安装连接扩展</button><button id="extension-disconnect" type="button" class="button secondary" hidden>断开扩展连接</button></div>'''
    template = template.replace('        </form>', extras + '\n        </form>', 1)
    template = template.replace('<div id="test-message"', '<p id="connection-status" role="status" hidden></p><div id="test-message"', 1)
    template = template.replace('<p id="connection-status"', EXTENSION_SETUP + '<p id="connection-status"', 1)
    notice = '''<div id="private-warning" class="portable-notice private" hidden>私人测试版 · 请勿转发</div>'''
    template = template.replace('        <form id="conn-form"', notice + '\n        <form id="conn-form"')
    template = template.replace(notice, GUIDE + notice)
    # Model entry must also be available when /models is unsupported or blocked.
    template = template.replace('class="form-panel picker-panel" hidden', 'class="form-panel picker-panel"')
    sources = []
    for name in ('static/theme-toggle.js', 'static/fingerprint-core.js', 'static/challenge-browser.js', 'portable/extension-client.js', 'portable/portable.js'):
        js = (PROJECT / name).read_text(encoding="utf-8")
        js = re.sub(r'^import .*?;\n', '', js, flags=re.M)
        js = re.sub(r'\bexport (?=(?:const|function|class|async)\b)', '', js)
        sources.append(js)
    studio = (PROJECT / 'static/studio.js').read_text(encoding="utf-8")
    studio = studio.replace('  var CONVERGE_P', '  var storage = window.ModelTracePortable.storage;\n  var CONVERGE_P').replace('localStorage.', 'storage.')
    studio = studio.split('  /* ---------- 指纹库：GitHub 更新 ---------- */')[0] + '''\n  loadProviders(window.ModelTracePortable.defaultProviderId);\n  window.ModelTracePortable.initialize();\n})();\n'''
    bank = public_bank(json.loads((PROJECT / 'data/unified_bank.json').read_text(encoding="utf-8")))
    package = io.BytesIO()
    with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in ('manifest.json', 'background.js', 'content.js', '安装说明.md'):
            archive.write(PROJECT / 'browser-extension' / name, 'ModelTrace-连接扩展/' + name)
        archive.write(PROJECT / 'LICENSE', 'ModelTrace-连接扩展/LICENSE')
    (PROJECT / 'ModelTrace-Extension.zip').write_bytes(package.getvalue())
    extension = {'fileName': 'ModelTrace-连接扩展.zip', 'data': base64.b64encode(package.getvalue()).decode('ascii')}
    template += '<script id="release-meta" type="application/json">' + script_json({'private': private, 'defaultProviderId': providers[0]['id'] if providers else '', 'repositoryURL': REPOSITORY}) + '</script>\n'
    template += '<script id="private-config" type="application/json">' + script_json(providers) + '</script>\n'
    template += '<script id="extension-package" type="application/json">' + script_json(extension) + '</script>\n'
    template += '<script id="fingerprint-bank" type="application/json">' + script_json(bank) + '</script>\n'
    template += '<script id="bank-meta" type="application/json">' + script_json({'upstream': 'https://raw.githubusercontent.com/xqy2006/ModelTrace/main/static/data/unified_bank.json', 'updatedAt': None}) + '</script>\n'
    template += '<script>\n(function () {\n' + '\n'.join(sources).replace('</script', '<\\/script') + '\n})();\n' + studio.replace('</script', '<\\/script') + '\n</script>\n</body>\n</html>\n'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(template, encoding="utf-8")
    if private:
        destination.chmod(0o600)
    print(f'Built {destination.name}: {destination.stat().st_size:,} bytes; private={private}; models={len(bank["models"])}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=PROJECT / 'ModelTrace.html')
    parser.add_argument('--private-config', type=Path)
    args = parser.parse_args()
    build(args.output, json.loads(args.private_config.read_text(encoding='utf-8')) if args.private_config else None)


if __name__ == '__main__':
    main()

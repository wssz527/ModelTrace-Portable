# ModelTrace Portable

一个可直接分享的模型指纹测试 HTML，支持 API 测试与手动粘贴归因。

[下载 HTML](https://github.com/wssz527/ModelTrace-Portable/releases/latest/download/ModelTrace.html) · [使用说明](使用说明.md) · [上游 ModelTrace](https://github.com/xqy2006/ModelTrace) · [上游指纹浏览与测试](https://xqy2006.github.io/ModelTrace/)

## 开始使用

1. 下载 `ModelTrace.html`，在桌面 Edge / Chrome 中打开。
2. 填写自己的 Base URL 和 API Key，点击“拉取模型”。
3. 勾选模型，点击“开始测试”，勾选“第 1 轮”。需要时继续下一轮，或选择“自动跑到收敛”。

支持 OpenAI Chat Completions 和 Anthropic Messages 接口。不提供模型列表的接口可手动添加模型名。

手动测试：生成挑战 → 复制提示词到待测模型 → 粘贴完整回答 → 计算归因。此方式无需填写 API Key。

## 只分享一个文件

直接发送下载的 `ModelTrace.html`，或在“指纹库与数据”中点击“导出分享版 HTML”。

HTML 内置指纹库、评分算法和连接扩展安装包，无需另附文件，不需要 App、本地服务或云端转发服务。

## 需要连接扩展时

先使用浏览器直连。连接失败时，按弹窗操作：

1. 点击“下载扩展”，解压到固定文件夹。安装包来自当前 HTML，无需联网下载。
2. 复制弹窗中的扩展管理页地址，在同一个浏览器的地址栏打开。
3. 开启“开发人员模式”，点击“加载解压缩的扩展”，选择包含 `manifest.json` 的 `ModelTrace-连接扩展` 文件夹。
4. 打开扩展详情，开启“允许访问文件网址”。
5. 刷新 HTML，点击“检测并继续”。
6. 核对 API 地址，点击“允许连接”。

首次安装由用户手动确认，HTML 不会自动安装扩展。安装后保留扩展文件夹；后续仍在 HTML 中操作，无需另开程序。点击“断开扩展连接”可撤销当前页面的连接授权。

扩展适用于桌面 Edge / Chrome（Chromium 120+），不适用于 Safari、手机浏览器或应用内预览。

## 更新指纹库

“指纹库与数据” → “拉取最新指纹库” → 打开下载的新版 HTML。

需要写回原文件时，点击“保存到当前 HTML”，选择正在使用的 HTML 并授权写入。仅拉取指纹库不会要求选择文件夹。

## 数据与隐私

- 发布文件不包含任何提供商预设、账号、API Key 或个人测试记录。
- 评分在浏览器本地完成。API 请求发往用户填写并授权的接口，不经过本项目服务器。
- 保存提供商时，默认只保存名称和地址；勾选“在本机记住密钥”后才保存 API Key。
- 导出分享版不携带提供商配置、密钥或当前测试结果；请勿直接转发自己的私人测试文件。
- 连接扩展不读取登录态、Cookie 或本地 CLI 凭据，不保存 API Key。

## 常见问题

| 状态 | 操作 |
| --- | --- |
| 未检测到扩展 | 确认扩展已启用并允许访问文件网址，在安装扩展的浏览器中刷新 HTML |
| HTTP 401 / 403 | 检查接口地址、密钥、账号权限及服务商限制 |
| HTTP 402 | 检查服务商账户余额及模型计费要求 |
| 请求超时 | 检查服务商响应情况，按需手动重试 |
| 无法列出模型 | 手动输入服务商提供的模型名 |
| 回答不完整或有效数字不足 | 检查模型响应，按需手动重新测试；失败的生成请求不会自动重发 |

连接扩展解决浏览器跨域访问问题，不解除服务商鉴权、网络、地域或风控限制。归因只比较当前指纹库内的候选模型，不能单独证明模型身份或账号能力变化。

## 从源码构建

需要 Python 3.10+，无额外构建依赖：

```sh
python3 build_portable.py --output ModelTrace.html
```

构建生成自包含 HTML 和内置扩展的 ZIP 副本。用户使用成品不需要 Python 或 Node.js。

源码目录：`portable/` 是 HTML 运行逻辑，`browser-extension/` 是连接扩展，`static/` 是评分与测试界面，`data/unified_bank.json` 是内置指纹库。

## 开发与测试

浏览器回归测试需要 Node.js 18+ 和 Playwright：

```sh
npm install --no-save playwright
npx playwright install chromium
python3 build_portable.py
node tests/test_connection_failure.cjs
node tests/test_extension.cjs
```

测试使用临时浏览器配置和模拟接口，不需要 API Key，不调用付费模型。也可设置 `MODELTRACE_BROWSER` 为本机 Edge / Chrome 的可执行文件路径。

已在 macOS 的 Edge 中实测浏览器直连、扩展模型拉取、OpenAI / Anthropic 单轮生成和本地归因。Windows 尚未进行实际运行验证。

欢迎通过 [Issues](https://github.com/wssz527/ModelTrace-Portable/issues) 反馈问题或提交 Pull Request。请提供浏览器版本、操作步骤和脱敏后的错误信息，不要提交密钥或私人配置。

## 上游与许可证

本项目是 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 的便携改进版，不是上游官方发行版。指纹算法、原始指纹库和基础测试界面来自上游；本项目增加单文件构建、浏览器本地测试、干净分享导出及可选连接扩展。

[上游在线指纹浏览与测试](https://xqy2006.github.io/ModelTrace/) · [本项目仓库](https://github.com/wssz527/ModelTrace-Portable)

采用 [MIT 许可证](LICENSE)，保留上游 `Copyright (c) 2026 xqy2006` 声明。许可证同时包含在 HTML 和内置扩展安装包中。

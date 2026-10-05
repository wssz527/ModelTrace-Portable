# ModelTrace Portable

一个可直接分享的模型指纹测试 HTML，支持 API 测试与手动粘贴归因。

[下载 HTML](https://github.com/wssz527/ModelTrace-Portable/releases/latest/download/ModelTrace.html) · [使用说明](使用说明.md) · [上游 ModelTrace](https://github.com/xqy2006/ModelTrace) · [上游指纹浏览与测试](https://xqy2006.github.io/ModelTrace/)

## 开始使用

1. 下载 `ModelTrace.html`，在桌面 Edge / Chrome 中打开。
2. 填写自己的 Base URL 和 API Key，点击“拉取模型”。
3. 勾选模型，点击“开始测试”，勾选“第 1 轮”。需要时继续下一轮，或选择“自动跑到收敛”。

支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 接口。不提供模型列表的接口可手动添加模型名。

思考强度默认“不发送”。需要指定时，可手动选择低、中或高。

手动测试：生成挑战 → 复制提示词到待测模型 → 粘贴完整回答 → 计算归因。此方式无需填写 API Key。

## 接入 CPA 或其他本机 API

1. 在 CPA 或其他转换工具中启用本机 API，取得 API 地址和该工具的访问密钥。
2. 将地址填写到 Base URL，将访问密钥填写到 API Key。
3. 选择工具提供的接口格式；原生 `/v1/responses` 选择“OpenAI Responses”，然后拉取模型并测试。
4. 点击“保存为提供商”，填写名称并保存，后续直接选择。

本机地址支持 `http://127.0.0.1` 和 `http://localhost`；端口和路径以转换工具的设置为准。工具需提供模型列表接口 `/models`（可选）以及 `/chat/completions`、`/responses` 或 `/messages` 生成接口，通常位于 `/v1` 下。

Responses 每轮只发送本轮提示词，使用 `store: false`，不携带历史响应 ID、会话或工具上下文。当前使用非流式请求；默认仍不发送思考强度，手动选择时按原生 `reasoning.effort` 格式发送。字段定义见 [OpenAI 官方 Responses 文档](https://developers.openai.com/api/reference/resources/responses/methods/create)。

订阅登录和 API 转换由用户已有的工具处理。HTML 不扫描账号登录态、不读取订阅凭据，也不调用本地 CLI。连接失败时按同一扩展弹窗处理。

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

已安装旧扩展而需要 Responses 时，按更新提示下载并覆盖原扩展文件夹，在扩展管理页点击“重新加载”，然后刷新 HTML。

## 更新指纹库

默认来源是原版上游 [xqy2006/ModelTrace 的统一指纹库](https://raw.githubusercontent.com/xqy2006/ModelTrace/main/static/data/unified_bank.json)，不是本项目仓库。在“更新设置”可查看或修改 JSON 地址。

“指纹库与数据” → “拉取最新指纹库” → 打开下载的新版 HTML。

需要写回原文件时，点击“保存到当前 HTML”，选择正在使用的 HTML 并授权写入。仅拉取指纹库不会要求选择文件夹。

## 数据与隐私

- 发布文件不包含任何提供商预设、账号、API Key 或个人测试记录。
- 评分在浏览器本地完成。API 请求发往用户填写并授权的接口，不经过本项目服务器。
- 保存提供商时，默认只保存名称和地址；勾选“在本机记住密钥”后才保存 API Key。
- 导出分享版不携带提供商配置、密钥或当前测试结果；请勿直接转发自己的私人测试文件。
- 连接扩展不读取登录态、Cookie 或本地 CLI 凭据，不保存 API Key。

## 本机保存与带库分享

- 保存提供商后，在同一个浏览器配置中重新打开同一个 HTML，名称和地址会保留。需要保留密钥时勾选“在本机记住密钥”；取消勾选会移除浏览器保存的密钥。
- 导入或更新指纹库后，当前库保存在浏览器中。关闭浏览器再打开仍可使用；要让文件本身携带当前库，点击“保存到当前 HTML”或使用更新后下载的 HTML。
- 点击“导出分享版 HTML”，当前指纹库会内置到新文件，提供商、地址、密钥及测试结果不会导出。对方在自己的浏览器打开即可使用该库。
- 所有提供商使用当前统一参考指纹库。保存提供商不会创建独立指纹库，测试回答也不会自动加入参考库；当前测试卡片和结果不作为历史记录持久保存。

浏览器本机保存依赖普通浏览器配置及允许本地存储；无痕模式、清除浏览器数据或换浏览器时不能依赖这些记录。HTML 内置的指纹库仍随文件保留。

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
node tests/test_persistence.cjs
```

测试使用临时浏览器配置和模拟接口，不需要 API Key，不调用付费模型。也可设置 `MODELTRACE_BROWSER` 为本机 Edge / Chrome 的可执行文件路径。

已在 macOS 的 Edge 中实测浏览器直连、扩展模型拉取、OpenAI / Anthropic 单轮生成和本地归因。Windows 尚未进行实际运行验证。

欢迎通过 [Issues](https://github.com/wssz527/ModelTrace-Portable/issues) 反馈问题或提交 Pull Request。请提供浏览器版本、操作步骤和脱敏后的错误信息，不要提交密钥或私人配置。

## 上游与许可证

本项目是 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 的便携改进版，不是上游官方发行版。指纹算法、原始指纹库和基础测试界面来自上游；本项目增加单文件构建、浏览器本地测试、干净分享导出及可选连接扩展。

[上游在线指纹浏览与测试](https://xqy2006.github.io/ModelTrace/) · [本项目仓库](https://github.com/wssz527/ModelTrace-Portable)

采用 [MIT 许可证](LICENSE)，保留上游 `Copyright (c) 2026 xqy2006` 声明。许可证同时包含在 HTML 和内置扩展安装包中。

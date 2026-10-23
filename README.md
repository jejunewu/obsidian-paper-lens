# Paper Lens

Paper Lens 在一个 Obsidian 标签页中提供原文 PDF 和可展开的中文译文，对话使用独立的 Claudian 插件。首版面向 macOS 桌面和可选中文字的英文论文，最低 Obsidian 版本为 1.12.7。

支持缩放、连续/单页阅读、双向滚动同步、可拖动分隔栏、黄色高亮、可编辑和移动的文字批注、删除与撤销。保存批注写回原 PDF，首次保存保留 `文件.pdf.paper-lens.bak`；已有其他阅读器批注保留，源文件外部修改时拒绝覆盖。文字批注嵌入完整中文字体，会增加约 16 MB 文件体积。关闭时提供保存/放弃；取消关闭会在新标签页恢复当前论文及草稿。

全文翻译按页交付，未完成页显示同尺寸占位。全部完成且文件校验通过后，译文保存为同目录的 `文件.zh-CN.pdf`，重名追加编号。失败/取消保留有效页面，重开论文可恢复检查点，点击全文翻译重试。进度区域持续显示失败原因；“翻译任务详情”显示准备过程和 Agent 输出。Agent 只回复文字而未交付完整 PDF 时，任务会明确失败并允许重试。

与 Claudian 一起使用：

1. 在同一个 Vault 启用 Claudian，并打开它的对话面板。
2. 用 Paper Lens 打开 PDF，保持工具栏的“选择”模式。
3. 鼠标拖选文字；Claudian 输入框上方出现 `1 line selected` 等选区提示。
4. 在 Claudian 中提问，当前片段和 PDF 路径会自动作为上下文发送。

无需复制粘贴或在 Paper Lens 重配对话模型。Paper Lens 使用 Obsidian 标准 FileView，复用 Claudian 的原生选区机制，不修改 Claudian。已实测 Claudian 2.3.28 / Obsidian 1.14.4；当前自动上下文不携带 PDF 页码。扫描 PDF 没有文本层，不能选择片段。Paper Lens 自带对话面板已移除；以前的聊天文件保留在工作目录，后续对话历史由 Claudian 管理。

本地 CLI 需已安装并能够正常回答。插件自动从登录交互 shell 加载终端导出的环境变量，沿用现有 Codex 的 provider、模型、审批和沙箱配置；无需重新配置 API Key。终端环境只缓存在内存，不写入插件设置。CLI 路径和模型留空即可；设置中的“测试连接”会实际验证默认 Agent 是否能回答。修改 shell 导出变量后，重新加载插件使缓存更新。设置可指定 CLI 路径、模型、工作目录及翻译 skill。翻译 Agent 请求工具权限时在任务提示区域允许或拒绝本次操作。切换 Agent 影响后续翻译任务。收起译文面板不会停止翻译；关闭文档/卸载插件中断其自身翻译任务并保留检查点。

翻译由 Agent 执行自带 skill，自动准备缓存中的 uv、Python 3.12.12 和 PyMuPDF 1.25.5；用户无需预装 Python。初次准备需网络下载。默认工作目录为 `~/Library/Application Support/Paper Lens`，保存论文快照和翻译产物，可在设置中更改。

扫描件 OCR、原 PDF 正文编辑、移动端、远程 Agent 和终端嵌入不在首版范围。图片中的文字不做 OCR。版式目标是页序、尺寸、图表和公式保留，中文在原文字区域可读；特别密集的公式/表格或旋转文字可能被明确标记失败。验证现状见 [验证记录](docs/VALIDATION.md)。

## 开发

开发依赖当前 Node.js（建议 26，Vitest 5 要求 Node 22.12/24/26 及以上）和 npm。

```sh
npm ci
npm run dev
```

`npm run dev` 监听源码变更并生成根目录下的 `main.js`。修改源码后，需要在 Obsidian 中重新加载插件；构建监听本身不会自动重载插件。

```sh
npm run typecheck
npm run test
npm run build
npm run package
```

`npm run build` 先检查 TypeScript 类型，再生成生产构建。

## 在 Obsidian 中加载

1. 在测试 Vault 中创建 `.obsidian/plugins/paper-lens/` 目录。
2. 执行 `npm run package`，将 `dist/paper-lens-0.1.0.zip` 解压到该目录；包含 `main.js`、`manifest.json`、`styles.css` **和 `resources/`**，资源目录不可省略。也可直接复制 `dist/` 中这四项。
3. 在 Obsidian 的设置 → 第三方插件中关闭受限模式，启用 **Paper Lens**；如未显示，重启 Obsidian。

启用后通过 PDF 右键“使用 Paper Lens 打开”、命令面板“Paper Lens：打开论文 PDF”或侧边栏图标打开。也可以把 Vault 内 PDF 拖入 Paper Lens 面板。默认 PDF 打开行为保持独立。

## 文件结构

```text
src/main.ts          插件入口与打开命令
src/pdf/             PDF 阅读与标准注释写回
src/agents/          Codex JSON-RPC / Claude Agent SDK
src/translation/     检查点、产物验证与自动保存
src/ui/              原文/译文工作区与弹窗
src/core/            批注、坐标与协议类型
skills/              翻译 skill 和排版工具
assets/              中文字体及许可证
tests/               Vitest 自动化测试
docs/VALIDATION.md   实际验收结果和待验证项
manifest.json        Obsidian 插件元信息
styles.css           插件样式
versions.json        插件版本与最低 Obsidian 版本的对应关系
esbuild.config.mjs   开发监听与生产构建配置
tsconfig.json        TypeScript 配置
```

构建产物和插件本地数据不纳入 Git。发布新版本时，同步更新 `package.json`、`manifest.json` 和 `versions.json`。

开发验证本地 Agent：`node scripts/smoke-agents.mjs`，可追加 `codex` 或 `claude` 只测一个 Agent（复用现有 CLI 和终端环境，不修改凭据）。排版工具验证：先执行 `bash skills/paper-lens-translate/scripts/bootstrap.sh /tmp/paper-lens-tools`，再运行 `/tmp/paper-lens-tools/venv/bin/python scripts/smoke-translation.py`。

资源许可证：PDF.js Apache-2.0，pdf-lib / fontkit MIT，Noto Sans CJK 字体 SIL OFL（随资源附许可证）。Claude Agent SDK 采用包内条款。Agent 安装的 PyMuPDF 为 AGPL/商业双重许可；分发闭源派生产品或服务前需确认适用条款和商业授权。工具独立执行，不打包 PyMuPDF wheel。

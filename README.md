# Paper Lens

Paper Lens 在一个 Obsidian 标签页中提供原文 PDF、可展开的中文译文和本地 Codex / Claude Code 论文对话。首版面向 macOS 桌面和可选中文字的英文论文，最低 Obsidian 版本为 1.12.7。

支持缩放、连续/单页阅读、双向滚动同步、可拖动分隔栏、黄色高亮、可编辑和移动的文字批注、删除与撤销。保存批注写回原 PDF，首次保存保留 `文件.pdf.paper-lens.bak`；已有其他阅读器批注保留，源文件外部修改时拒绝覆盖。文字批注嵌入完整中文字体，会增加约 16 MB 文件体积。关闭时提供保存/放弃；取消关闭会在新标签页恢复当前论文及草稿。

全文翻译按页交付，未完成页显示同尺寸占位。全部完成且文件校验通过后，译文保存为同目录的 `文件.zh-CN.pdf`，重名追加编号。失败/取消保留有效页面，重开论文可恢复检查点，点击全文翻译重试。任务错误会显示在进度区域。

对话依据原文分页面文本索引，支持流式回答、停止、新会话、选中文字和 `[p. N]` 页码跳转。聊天按原文版本和 Agent 隔离保存。

本地 CLI 需已安装并能够正常回答。插件沿用 CLI 的登录和模型设置，不另存 API Key。设置可指定 CLI 路径、模型、工作目录及翻译 skill。Agent 请求工具权限时在任务提示区域或对话栏允许或拒绝本次操作。切换 Agent 影响后续任务，正在运行的原 Agent 对话可切回查看。关闭面板不会停止任务；关闭文档/卸载插件中断其自身任务并保留检查点。

翻译由 Agent 执行自带 skill，自动准备缓存中的 uv、Python 3.12.12 和 PyMuPDF 1.25.5；用户无需预装 Python。初次准备需网络下载。默认工作目录为 `~/Library/Application Support/Paper Lens`，保存论文快照、分页面正文、聊天和翻译产物，可在设置中更改。

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
src/ui/              三栏工作区、对话与弹窗
src/core/            批注、坐标、正文检索与协议类型
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

开发验证本地 Agent：`node scripts/smoke-agents.mjs`（会调用现有 CLI；不读取或修改凭据）。排版工具验证：先执行 `bash skills/paper-lens-translate/scripts/bootstrap.sh /tmp/paper-lens-tools`，再运行 `/tmp/paper-lens-tools/venv/bin/python scripts/smoke-translation.py`。

资源许可证：PDF.js Apache-2.0，pdf-lib / fontkit MIT，Noto Sans CJK 字体 SIL OFL（随资源附许可证）。Claude Agent SDK 采用包内条款。Agent 安装的 PyMuPDF 为 AGPL/商业双重许可；分发闭源派生产品或服务前需确认适用条款和商业授权。工具独立执行，不打包 PyMuPDF wheel。

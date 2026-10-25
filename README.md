# Paper Lens

在 Obsidian 中阅读、批注英文论文，并在同一标签页对照简体中文译文。支持 macOS 桌面和本地 Vault，要求 Obsidian 1.12.7 或更新版本。翻译面向可提取文字的 PDF。

全文翻译使用 **PDFMathTranslate-next 2.9.0 / BabelDOC 0.6.2**：在本地解析 PDF、识别版面和段落、处理公式并重新排版，段落翻译调用用户配置的 OpenAI 兼容模型 API。论文问答可配合独立的 **Claudian** 插件使用。

## 安装与打开

1. 解压 `dist/paper-lens-0.2.0.zip`，将 `main.js`、`manifest.json`、`styles.css` 和完整的 `resources/` 放到 Vault 的 `.obsidian/plugins/paper-lens/`。
2. 在 Obsidian 的第三方插件设置中启用 Paper Lens。更新时替换上述文件，再关闭并启用插件。
3. 点击侧边栏的“Paper Lens：打开论文”、执行命令“打开论文 PDF”，或在 PDF 文件右键菜单中选择“使用 Paper Lens 打开”。

原文栏始终显示；工具栏的“打开译文 / 关闭译文”按钮展开或收起对照栏，分隔线可以拖动调整宽度。原文和已完成并保存的译文均支持批注：先点击目标栏，再使用工具，状态行显示“当前编辑：原文 / 译文”。

## 阅读与批注

- **选择 / 拖动**：选择 PDF 文字及批注，或拖动平移页面。
- **荧光笔**：点击后进入连续标注模式，选中文字并松开即可自动高亮；已有选区时点击可直接高亮。再次点击、切换工具，或在阅读区域按 Esc 退出。旁边的色块显示当前颜色，点击可选任意颜色。选择模式下选中已有高亮可修改颜色。
- **插入文本**：通过旁边的色块选择文字颜色，调整字号（6–96 pt），再点击工具和 PDF 放置文字框。背景透明，放置后返回选择模式。选中文字框可拖动，右下角手柄调整大小，双击编辑内容。
- **删除 / 撤销**：删除选中的 Paper Lens 批注，或撤销本次保存前的新增、编辑、移动、调整大小及删除操作。
- **保存**：保存两栏的待保存批注，分别写入对应的原文或译文 PDF；各文件首次保存保留 `文件.pdf.paper-lens.bak`，其他阅读器的批注保留。文件被外部修改时拒绝覆盖。关闭有未保存批注的文档时，可保存、放弃或取消关闭。两栏各自维护选中批注、撤销记录和恢复草稿；关闭译文栏后，待保存批注仍保留。
- **缩放**：支持 −/+、25%–400% 百分比输入、“适合宽度”、触控板捏合和 Ctrl + 滚轮；两栏共享缩放比例。普通双指滚动用于滚动页面。
- **翻页**：连续滚动或单页阅读，支持上一页、下一页和页码跳转。

展开译文后可切换“同步滚动 / 独立滚动”。同步时两栏保持相同页码和页内相对位置；独立时各自滚动，翻页按钮和页码输入作用于最后操作的一栏。重新开启同步时对齐到当前操作栏。工作区保存滚动模式、两栏位置和缩放比例。

文字颜色、字号及批注位置保存到 PDF。中文文字批注嵌入约 16 MB 的完整字体，后续保存复用字体资源；文字超出框时需扩大框或缩短内容。

## 配置与翻译

打开 Obsidian → 设置 → Paper Lens：

| 配置 | 说明 |
| --- | --- |
| 模型 API 地址 | 支持 `https://api.example.com/v1`、自定义前缀（如 `/openai/v1`）和完整 `/chat/completions` 地址。填写服务实际提供的路径，不自动补猜前缀。 |
| API Key | 存入 Obsidian 原生密钥存储。无认证的本地服务可填任意非空值。 |
| 翻译模型 ID | 填写服务实际支持的模型；文本模型即可。 |
| 推理强度 | 默认不发送 `reasoning_effort`，仅在服务支持时选择。 |
| 请求超时 | 单次请求 10–600 秒，默认 60 秒；长段落可调到 120 秒或更高。 |
| 翻译请求并发 | 1–4，默认 4；也作为每秒请求上限，服务限流时降低。 |
| 自动提取术语表 | 默认关闭；开启可改善术语一致性，会增加 API 请求和耗时。 |
| 工作目录 | 默认 `~/Library/Application Support/Paper Lens/`，存放运行环境、原文快照和任务产物。 |

1. 点击“测试连接”，验证地址、认证和模型。接口使用 `POST /chat/completions`，无需图片输入、工具调用或 JSON 模式。
2. 工具栏可切换模型或填写自定义模型 ID。“刷新模型”调用可选的 `GET /models`；服务没有模型目录时仍可直接填写 ID。
3. 点击“全文翻译”。首次运行自动准备隔离的 Python 3.12 环境，并下载依赖、识别模型和字体，需要联网及数百 MB 缓存空间。
4. 任务显示解析、版面识别、段落翻译和排版进度。全文生成后校验页数、尺寸和摘要，再加载译文并保存 PDF。

### 译文位置与恢复

译文保存在原 PDF 同目录，命名为 `文件.zh-CN.pdf`；重名追加编号，避免覆盖已有文件。工作目录另保留任务清单、单页产物及 `final.pdf`。

在同一 Vault 内移动或重命名原文、父文件夹后，插件通过源内容摘要和模型配置找回已完成任务，重新关联译文。原文或译文保存 Paper Lens 荧光笔或文字批注后，重启仍可恢复译文及其批注，无需重新翻译。译文的文件摘要改变时，会与经校验的任务产物比较正文对象图，确认仅有 Paper Lens 批注变化后重新关联。若导出文件缺失，可从有效任务产物恢复译文正文，导出文件中的批注需从备份找回。正文、页面结构或模型配置改变时不会套用不匹配的任务。

“取消翻译”终止本地任务；失败或取消后点击“全文翻译”重新处理全文。已完成任务可以直接恢复。当前不提供段落级断点续译，也不使用上游共享段落缓存。

### Claudian 选区读取

安装并启用 Claudian，打开 Paper Lens 原文，在**选择模式**中选中 PDF 片段。Claudian 可读取当前 PDF 文件上下文和选区，作为问题的参考内容。问答的模型、权限及会话由 Claudian 管理；Paper Lens 专注阅读、批注与翻译。荧光笔模式会清除已落色的文本选区，需要问答时切回选择模式重新选中。

### 数据与使用边界

API Key 通过标准输入传给本地运行进程，不写入命令参数、插件配置或任务文件。段落文本发送到配置的模型服务，API 费用由该服务商收取；本地识别和排版不调用其他付费云服务。

扫描 PDF 暂不支持，需先处理为可提取文字的文档。公式、图表及分页由上游框架尽量保留；密集算法、小字号、复杂公式和参考文献仍可能出现排版问题。检测到段落翻译失败时拒绝自动发布不完整译文。结构校验通过不等于全部语义和版面已人工审校。

## 开发

```sh
npm install
npm run typecheck
npm run package
```

`npm run dev` 开启构建监听。生产打包仅包含插件代码及运行资源。

测试和开发记录放在被 Git 忽略的 `dev/` 中，测试目录为 `dev/tests/`。新克隆仓库不包含这些本地文件；有本地测试文件时运行：

```sh
npm test
"/path/to/tools/pdfmath-2.9.0-v1/venv/bin/python" dev/tests/pdfmath_bridge_test.py
# 含真实引擎与本地错误 API 的回归，无付费调用：
PAPER_LENS_RUNTIME_TEST=1 "/path/to/tools/pdfmath-2.9.0-v1/venv/bin/python" dev/tests/pdfmath_bridge_test.py
```

本地真实 API 冒烟测试需要 `dev/tests/smoke-translation.mjs` 和显式环境配置：

```sh
# 预先在当前进程环境中配置 PAPER_LENS_API_KEY
export PAPER_LENS_API_BASE_URL=https://api.example.com/v1
export PAPER_LENS_API_MODEL=your-model-id
npm run smoke:translation -- /tmp/paper-lens-pdfmath-smoke
# 可选第二个参数：输入 PDF；副本及译文均保存在测试目录
```

可选参数：`PAPER_LENS_API_TIMEOUT`、`PAPER_LENS_API_CONCURRENCY`、`PAPER_LENS_API_EFFORT`、`PAPER_LENS_API_GLOSSARY=1`。依赖安装遵循 uv 的代理和镜像配置，如 `UV_INDEX_URL`。

| 目录 | 内容 |
| --- | --- |
| `src/pdf/` | PDF.js 阅读、批注和源文件保存 |
| `src/translation/` | 模型 API、运行进程、任务管理及产物校验 |
| `src/ui/` | 双栏阅读、批注工具和翻译进度 |
| `runtime/pdfmath/` | 固定版本依赖、启动脚本、框架适配及许可 |
| `assets/` | 中文批注字体及许可 |
| `scripts/` | 安装包构建 |
| `dev/tests/` | 本地测试与冒烟脚本，不追踪 |

实现说明见 [翻译流程](docs/TRANSLATION.md)，验证范围见 [验收记录](docs/VALIDATION.md)，功能更新见 [更新记录](CHANGELOG.md)。

PDFMathTranslate-next 和 BabelDOC 使用 AGPL-3.0，PyMuPDF 使用 AGPL/商业许可。安装包包含框架许可文本和来源链接，Python 依赖及下载资源各自保留许可。分发和修改时须遵守相应许可，见 [运行时说明](runtime/pdfmath/NOTICE.md)。

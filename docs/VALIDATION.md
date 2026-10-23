# 首版验证记录

自动化验证使用 `npm run test`、`npm run typecheck`、`npm run build`。测试覆盖页内同步、旋转坐标、批注撤销、UTF-8 分片 JSON、Agent 异常退出和取消、逐页产物摘要/尺寸/路径约束、任务重复通知和半写清单、源文档冲突、首次备份及非覆盖输出。

自动化覆盖同文档任务互斥和恢复读取，以及终端环境继承、shell 超时、翻译失败持久化/重试、无产物完成事件和进度刷新不覆盖错误。通过反转产物摘要判断确认测试会拒绝该回归。原始构建的 `npm audit` 无已知漏洞。

本次修复的 28 个 Vitest 测试（7 个文件）通过；反转“已保存”状态判断后，反馈测试失败，恢复代码后通过。Python 排版探针新增预览图与保存后 PDF 像素一致性检查，复现并修复了序列化后使用旧页面对象生成空白预览的问题。

开发机实测：Obsidian 1.14.4，Codex 0.163.0，Claude Code 2.1.304；最低 Obsidian 1.12.7 尚未实机复测。

已在 `/tmp/Paper Lens Acceptance` 独立 Vault 安装完整产物，验证打开论文、PDF 文本层、三栏展开、译文占位、两个方向的滚动同步和文字批注保存。PDF.js/Claude SDK 使用 CommonJS 资源；PDF worker 从本地资源创建 Blob worker，避免 Obsidian 禁止 file URL 动态模块的问题。

中文标准 FreeText 外观流已用 MuPDF 实际渲染并视觉确认。Noto CFF 字体采用完整字体嵌入，避免字体子集导致外部阅读器报错；这会增加原 PDF 的文件体积（约 16 MB 字体资源）。

对应计划的实现已落地：阅读工作区、两个 Agent 适配器、专用翻译 skill、逐页协议和自动保存、标准注释写回、论文检索/对话及资源打包。阶段 1 的两个真实 Agent 成功翻译和阶段 8 的全部桌面样本验收仍未达成，不能把当前构建视为完整验收通过。首次中文批注加入字体后，后续保存复用该资源，已用重复保存测试防止体积持续增加。

`scripts/smoke-translation.py` 使用合成双栏页，验证英文文字替换、中文提取、公式和线图保留、页数/尺寸保持、未视觉审阅标记拒绝发布、单页发布及最终合并。渲染结果已视觉查看。该脚本使用固定中文样本验证排版工具，不代表 Agent 翻译质量验收。

首次 Codex 调用失败的根因是进程环境差异：用户终端在 `.zshrc` 导出 `OPENAI_API_KEY`，Obsidian 没有继承该变量，并非用户需要重新配置 Codex。修复后，CLI 探针和 Obsidian 设置页的“测试连接”均使用现有配置返回“Paper Lens 连接成功”。插件还取消了固定审批/沙箱覆盖，默认沿用 Codex 配置。环境仅缓存在内存，不写入插件数据或输出日志。此前 Claude 调用返回 `400 Access to Anthropic models is not allowed for this account`，Claude 完整任务尚未复测通过。

独立测试 Vault 的三页 `sample.pdf` 已通过真实 Codex 翻译闭环：准备依赖、工具权限回调、逐页视觉检查/发布、合并、译文栏展示，最终自动保存为 `sample.zh-CN.pdf`。重新打开保存文件验证三页均包含中文正文，尺寸均为 600 × 800；桌面截图确认中文和原线图正常显示。此简单样本不能替代复杂论文验收。

仍需实机验收：macOS Preview 中文批注显示，Obsidian 1.12.7、真实公式密集页/复杂表格/长论文的翻译质量，以及正常账号下的权限回调和完整任务闭环。复杂布局无法达到可读性检查时工具明确失败，不标为完成。

## Claudian 选区兼容更新（2026-10-23）

移除 Paper Lens 自带聊天面板、消息存储和正文检索代码。阅读视图改为标准 Obsidian FileView，仍以 `paper-lens` 独立视图打开，兼容旧工作区的 `path` 状态；不注册为默认 PDF 阅读器。选择模式显式启用 PDF 文本层的 `user-select`，初次打开即生效。

独立测试 Vault `/tmp/Paper Lens Acceptance`、Obsidian 1.14.4、Claudian 2.3.28：在 Paper Lens 的合成 PDF 第二页三击选中 Results 段落后，Claudian 自动显示 `1 line selected`。空白会话只询问选区内容、禁止工具和文件读取，Claudian 正确回复 Dataset Aurora、70% → 82%、增加 12 个百分点及 `Claudian PDF Acceptance.pdf`。另外实测鼠标拖选 Limitation 段落、切换拖动模式并平移、选区添加荧光笔及撤销、译文面板展开、关闭并重新打开 PDF。自带对话入口和第三栏均已移除。

28 个 Vitest 测试（8 个文件）通过，类型检查和生产构建通过。其中两个旧自带对话检索测试随模块移除，新增两个文件视图状态测试，验证旧标签恢复和当前文件优先，避免其他插件获得错误 PDF 路径。自动化文件视图测试使用 Obsidian API 替身，真实 Claudian 兼容性由上述桌面验收确认。

Claudian 当前自动选区上下文包含文字与文件路径，不含 PDF 页码；未修改 Claudian，也未增加对其私有接口的依赖。旧 Paper Lens 聊天文件未删除。最低 Obsidian 版本及其他 Claudian 版本的兼容性尚未实机复测。

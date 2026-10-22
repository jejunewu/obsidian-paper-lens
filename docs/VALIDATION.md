# 首版验证记录

自动化验证使用 `npm run test`、`npm run typecheck`、`npm run build`。测试覆盖页内同步、旋转坐标、批注撤销、UTF-8 分片 JSON、Agent 异常退出和取消、逐页产物摘要/尺寸/路径约束、任务重复通知和半写清单、源文档冲突、首次备份及非覆盖输出。

最终自动化共 21 个测试（5 个测试文件），含同文档任务互斥和恢复读取。通过反转产物摘要判断确认测试会拒绝该回归。`npm audit` 当前无已知漏洞。

开发机实测：Obsidian 1.14.4，Codex 0.163.0，Claude Code 2.1.304；最低 Obsidian 1.12.7 尚未实机复测。

已在 `/tmp/Paper Lens Acceptance` 独立 Vault 安装完整产物，验证打开论文、PDF 文本层、三栏展开、译文占位、两个方向的滚动同步和文字批注保存。PDF.js/Claude SDK 使用 CommonJS 资源；PDF worker 从本地资源创建 Blob worker，避免 Obsidian 禁止 file URL 动态模块的问题。

中文标准 FreeText 外观流已用 MuPDF 实际渲染并视觉确认。Noto CFF 字体采用完整字体嵌入，避免字体子集导致外部阅读器报错；这会增加原 PDF 的文件体积（约 16 MB 字体资源）。

对应计划的实现已落地：阅读工作区、两个 Agent 适配器、专用翻译 skill、逐页协议和自动保存、标准注释写回、论文检索/对话及资源打包。阶段 1 的两个真实 Agent 成功翻译和阶段 8 的全部桌面样本验收仍未达成，不能把当前构建视为完整验收通过。首次中文批注加入字体后，后续保存复用该资源，已用重复保存测试防止体积持续增加。

`scripts/smoke-translation.py` 使用合成双栏页，验证英文文字替换、中文提取、公式和线图保留、页数/尺寸保持、未视觉审阅标记拒绝发布、单页发布及最终合并。渲染结果已视觉查看。该脚本使用固定中文样本验证排版工具，不代表 Agent 翻译质量验收。

两个真实 CLI 均成功创建会话并返回任务事件，但模型调用失败：Codex 当前 provider 配置要求 `OPENAI_API_KEY` 而本次进程环境中缺失；Claude 当前账号返回 `400 Access to Anthropic models is not allowed for this account`。插件不会修改这些配置、读取登录凭据或自动添加 API Key。需要本地 CLI 能正常响应之后，补做两个 Agent 的单页翻译、全文翻译和连续问答验收。

仍需实机验收：macOS Preview 中文批注显示，Obsidian 1.12.7、真实公式密集页/复杂表格/长论文的翻译质量，以及正常账号下的权限回调和完整任务闭环。复杂布局无法达到可读性检查时工具明确失败，不标为完成。

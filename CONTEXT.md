# Paper Reading 术语

| 术语 | 含义 |
|------|------|
| 分区 Partition | `data/library/` 下一级目录，如 AIGC |
| 论文夹 Paper | 分区内以 arXiv id 或标题 slug 命名的目录 |
| 章节块 SectionBlock | 相邻两个标题之间的正文区间（含其前导标题）；阅读页左右栏按此单位成对展示，两侧高度取较大值并完整显示 |
| 句对 SentencePair | 一条原文句单元与一条译文句单元的严格一一对应（同 `sentenceId`）；悬停任一侧时两侧同亮 |
| 句单元 | 按规则 A 切分：英文以 `. ? !` 分句；标题整段、独立公式、图/表题注、参考文献条目各为 1 个单元；复合插图（flex 多面板）拆成多个 figure/table 单元；段落之间插入独立的 `spacer` 空行单元；句中公式为内嵌节点 |
| 原文 | 论文英文内容；阅读主视图按章节块 + 句单元展示 |
| 全文翻译 | 对原文的忠实中文翻译：每个原文句单元对应恰好一条译文；不是概述或改写式总结 |
| 译文 | 全文翻译产物；与原文同构的章节块 + 句对；渲染时把 `⟦Mn⟧` 还原为原文 embeds（公式/图），`figure`/`table`/`equation`/`reference`/`spacer` 单元直接复用原文 HTML（不译） |
| 句中嵌入 embeds | 原文句里的公式/图片等富节点；LLM 侧用 `⟦M0⟧` 占位，落盘后前端按 embeds 还原 |
| 翻译批次 | 一次 LLM 调用处理一个章节块：输入该块全部原文句单元，输出同 `sentenceId` 的译文 |
| 批次流式预览 | 当前翻译批次进行中时，可将 LLM 原始流式输出显示为进度文本；**不**计入该块的句对渲染，也不写入已完成译文 |
| 结构解析 | 首次打开阅读页时，从 `article.html` 懒生成 `reading_structure.json`；须向用户展示解析进度 |
| reading_structure.json | 权威原文结构：章节块 + 原文句单元（含富文本节点与稳定 `sentenceId`）；首次进阅读页生成 |
| translation.json | 译文映射：`sentenceId → 中文`（及已完成章节块进度）；仅在整块校验通过后按批写入 |
| parsing | 正在做结构解析（生成 `reading_structure.json`）；与翻译分开的独立状态 |
| parse_failed | 结构解析失败；需手动重试解析 |
| translating | 全文翻译正在进行（当前有翻译任务在跑） |
| partial | 已有部分章节块译文，当前没有在跑；进阅读页时**自动续译**剩余块 |
| 暂停翻译 | 翻译中可手动暂停：丢弃**当前未完成章节块**的内存结果（不落盘），已完成块保留；状态变为 `partial`/`ready_source`，之后可「继续翻译」从该块重来 |
| completed | 全部章节块译文已完成 |
| translate_failed | 最近一次翻译批次失败；已成功块保留；进阅读页**不**自动重试，需手动「重试/继续」 |
| Block | 历史词：旧解析标题/段落单元；新模型优先用「章节块 / 句对」 |
| ImportJob | Next 进程内串行下载+本地化任务；完成后有 `article.html`，尚无阅读结构亦可进入阅读页 |
| 运行时 | 纯 Next.js 单进程（默认端口 6864）；无独立 Python/FastAPI 服务 |
| summary_v0 | **已废弃且库内旧数据已清除**；不再做迁移兼容 |
| notes.md | 用户为该论文手写的阅读笔记；落在论文夹根目录，与译文/结构并列；导入时即创建空文件 |
| 论文问答 Paper QA | 每篇论文唯一的问答助手；一条对话线程；不与笔记混存 |
| Paper QA 文档上下文 | 每次调用时从 `reading_structure.json` 现拼的英文原文（句单元 `text`，含章节标题分隔与 `⟦Mn⟧`）；不读 article.html，默认不含译文、**不注入** `notes.md` |
| Paper QA 历史窗口 | 落盘可存全量对话；每次 LLM 调用只截取最近 30 条消息进 prompt |
| Paper QA 弹层 | 居中大对话框 + 半透明遮罩；点遮罩或关闭按钮关闭；内含消息列表与输入框 |
| Paper QA 流式 | 助手回复 SSE/流式输出；用户消息发出时落盘，助手全文完成后再落盘；支持停止生成 |
| Paper QA 清空 | 支持一键清空整条对话线程；不做单条撤回 |
| Paper QA 回答语言 | 默认中文；专有名词、变量、公式符号保持原文 |
| Paper QA 可用时机 | 只要 `reading_structure.json` 已存在即可问答（翻译进行中亦可）；结构未就绪时按钮不可用 |
| Paper QA 渲染 | 助手消息对齐 progress：`remark-gfm` Markdown；公式先抽出再用 KaTeX 注入（兼容 `$…$` / `$$…$$` / `\(...\)` / `\[...\]`）；用户消息纯文本；流式中暂不排版公式 |
| Paper QA 能力边界 | 纯问答，无工具：不联网、不改笔记、不改译文/结构 |
| Paper QA 中断 | 关闭弹层或点停止：中止生成；已落盘用户消息保留；未完成的助手回复不落盘 |
| Paper QA 模型 | 与全文翻译共用同一套 LLM 配置（`.env` 的 API_KEY / BASE_URL / MODEL） |
| Paper QA 并行 | 可与全文翻译同时进行；不互相阻塞 |
| Paper QA 输入 | Enter 发送；Shift+Enter 换行 |
| qa-chat.json | 该论文 Paper QA 的轻量对话历史：消息为 `{id, role: user\|assistant, content, createdAt}` 序列；关闭弹层不丢历史；**懒创建**（首次问答读写时再建，导入不预建） |
| ready_source | 原文 HTML 已就绪；进阅读页 → `parsing` |
| interrupted | 未完成状态被标记为中断 |

## Relationships

- ImportJob → `article.html` + `ready_source` → 首次打开阅读页 → `parsing`（显示进度）→ `reading_structure.json` → `translating` →（可至）`partial` → … → `completed`。
- 每篇论文夹含至多一份 `notes.md`（手写笔记）与一份 `qa-chat.json`（Paper QA 对话历史）；二者独立。
- Paper QA：文档上下文来自 reading_structure 英文原文；不注入笔记；历史窗口 30；流式纯问答；`qa-chat.json` 懒创建。
- 未译章节块：右栏保留与左栏成对的等高空块 + 「待翻译」占位；当前批次块显示批次流式预览；已完成块显示句对。
- `partial` 进页自动续译；`translate_failed` / `parse_failed` 仅手动重试。
- 悬停联亮同一 `sentenceId`；成对章节块高度 = max(左, 右) 且完整显示文本。

## Flagged ambiguities

- 主路径已实现：结构懒解析 + 按章节块全文翻译 + 阅读页句对联亮。
- 句单元富文本 JSON 编码仍可在实践中继续打磨（数学占位符 / 拆句后 HTML 保真）。
- Paper QA 首版决策已收敛（见上表）；实现前若改「全文进 prompt」策略需重开讨论。
- 「Agent」在本产品中仅指 Paper QA（每篇一条线程），不是多角色 agent 框架。

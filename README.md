# paper-reading

本地双语论文阅读：分区档案库 → arXiv / ar5iv 导入 → 章节块双栏对读 + 句对全文翻译（非总结）→ 笔记 / Paper QA。

单进程 Next.js，默认端口 **6864**（含 UI 与 API），无独立 Python 服务。

## 快速开始

```bash
cp .env.example .env   # 填写 API_KEY / BASE_URL / MODEL
npm install
./start.sh             # 或 npm run dev → http://localhost:6864
```

强制释放占用端口：`FORCE_FREE_PORTS=1 ./start.sh`

生产：

```bash
npm run build && npm start
npm run dev
```

## 环境变量（`.env`）

| 变量 | 说明 |
|------|------|
| `API_KEY` | OpenAI 兼容网关密钥 |
| `BASE_URL` | API 根地址（无 path 时自动补 `/v1`） |
| `MODEL` | 模型名 |

LLM 只读 `.env`；应用内设置页仅可改 `libraryDir`（落盘 `data/settings.json`）。

## 功能概览

- **分区 / 论文**：侧栏管理，拖拽排序；粘贴 arXiv / ar5iv 链接导入
- **阅读**：英中双栏按章节块对齐；句对悬停联亮；公式 / 图复用原文 HTML
- **翻译**：进阅读页懒解析结构 → 按块流式翻译；可暂停 / 续译 / 失败后手动重试
- **笔记**：每篇 `notes.md`
- **Paper QA**：基于 `reading_structure` 原文上下文的流式问答（与翻译共用 LLM）

术语与状态机见 [CONTEXT.md](./CONTEXT.md)。

## 技术栈

- Next.js 15 + React 19（`src/app` 页面与 Route Handlers，`src/lib` 服务端逻辑）
- AI SDK（`ai` + `@ai-sdk/openai`）
- cheerio 解析 ar5iv HTML → `reading_structure.json`
- 数据：文件系统 `data/library/`（不迁 SQLite）

```bash
npm test    # src/lib/**/*.test.ts
npm run build
```

## 数据布局

```
data/
  settings.json          # 仅 libraryDir（可 gitignore）
  library/
    _order.json
    <Partition>/
      _order.json
      <slug>/
        meta.json
        article.html / assets/
        reading_structure.json
        translation.json
        notes.md
        qa-chat.json     # 懒创建
```

导入与翻译任务跑在 Next 进程内；进程重启会中断进行中的 job（与旧行为一致）。

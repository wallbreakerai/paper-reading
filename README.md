# paper-reading

本地双语论文阅读工具：档案库 → arxiv/ar5iv 导入 → 章节块双栏对读 + 句对全文翻译（非总结）。

## 启动

```bash
chmod +x start.sh
./start.sh
```

- 前端：http://localhost:6864  
- API：http://127.0.0.1:8010  

强制释放端口：`FORCE_FREE_PORTS=1 ./start.sh`

## 技术栈

- `web/` Next.js 15 + React 19  
- `python/` FastAPI  
- 数据：`data/library/`、`data/settings.json`  
- LLM：项目根目录 `.env`（`API_KEY` / `BASE_URL` / `MODEL`）  

```bash
cp .env.example .env
# 编辑 .env 后重启 ./start.sh
```

## 开发

依赖装在 **conda base**（不使用项目内 `.venv`）：

```bash
conda activate base
pip install -r python/requirements.txt
cd python && PYTHONPATH=. pytest -q
cd ../web && npm install && npm run dev -- -p 6864
```

视觉风格对齐 progress（Geist、中性 oklch、浅色侧栏）；分区支持拖拽排序。

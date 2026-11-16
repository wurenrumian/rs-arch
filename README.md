# rs-arch

RecStore 的架构与设计讲解，用 VitePress 组织的静态站点。内容回答“为什么这样设计、
这样设计会在哪里出问题”，不替代 API 文档。

- 六章 47 块：系统总览与构建 → 计算层 → 参数服务器与传输 → RDMA → 存储与内存 → 测试与工具
- 每章一张阅读地图（部件表 + 概念表 + 建议读法），之后一块一页
- 另有[核心事实](docs/guide/facts.md)、[代码索引](docs/guide/code-index.md)、
  [风险总表](docs/quality/risks.md)、[已修复记录](docs/quality/fixes.md)、
  [文档不一致](docs/quality/doc-gaps.md)、[未确认清单](docs/quality/unknowns.md)

事实基线是 RecStore 上游 `1f340167d`。本站**不包含** RecStore 源码，也不拉取它的
`third_party` 子模块；正文里的 `相对路径#符号` 是对着源码读出来的引用。

## 本地运行

```bash
npm install
npm run dev      # 默认 base 为 /rs-arch/，访问 http://localhost:5173/rs-arch/
npm run build    # 产物在 docs/.vitepress/dist
npm run preview
```

本地想用根路径预览：

```bash
VITEPRESS_BASE=/ npm run dev
```

## 目录

```text
docs/
  index.md                 首页
  guide/                   阅读指南、核心事实、代码索引
  ch01 … ch06/             六章正文：地图页 + 每块一页 + 风险 + 证据索引
  quality/                 风险总表、已修复、文档不一致、未确认清单
  .vitepress/              配置（导航 / 侧栏 / 中文检索）、主题样式、pele 图表渲染
  public/                  logo 与首页插图
```

侧栏与导航在 `docs/.vitepress/config.mts` 里集中定义；新增页面时同时改这里与对应的
章节地图页。中文检索用 mini-search 加了一个 CJK 二元组分词器，也在同一个文件里。

## 部署

静态产物挂在 rumian 宿主机的聚合站点上，路径 `/rs-arch/`。换路径时用
`VITEPRESS_BASE=<path>/ npm run build` 重新构建即可，站点自身的链接都是相对 base 的。

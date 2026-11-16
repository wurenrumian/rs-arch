---
title: 第 6 块：工程工具与文档构建
description: 围绕本地与 CI 结果一致，本章保留四条与本篇直接相关的工程工具入口。
outline: [2, 3]
---

## 它是什么

工具围绕"让同一套检查在本地和 CI 里跑出同样结果"展开。本章只保留四条与本篇内容直接相关的入口。

| 工具 | 入口 | 作用 |
| --- | --- | --- |
| 文档站 | `mkdocs.yml` + `docs/requirements.txt`，CI 执行 `mkdocs build --strict` | nav 覆盖 usage / dev / architecture / calc / parameter_server / storage / performance / api；`not_in_nav` 排除 `agent/perf.md`、`calc/interfaces.md`、`dev/performance.md`、`dev/zero_config_run.md` |
| 文档门禁 | `.github/workflows/doc-check.yml` | PR 触及 `README.md`、`docs/**`、`mkdocs.yml` 或部署 workflow 时跑同一套 `mkdocs build --strict`，坏链与失配的 nav 在合并前失败 |
| 格式 | `tools/format/clang_format.sh [--check] [--all\|--staged\|--changed]` + `.githooks/pre-commit` | 只处理 `src/**/*.{cc,cpp,h}`；CI 固定 `clang-format==18.1.3` |
| 注册守卫 | `src/test/scripts/check_test_registration.py`（ctest 项 `test_registration_consistency`） | 新增测试必须注册或写入 `EXEMPT`，见[第 3 块](./test-map) |

CI 复现（`tools/ci/reproduce.sh`）、覆盖率（`tools/coverage/`）、打包（`tools/packaging/`）、配置定位（`tools/config/`）、环境采集（`tools/env/collect.py`）仍在仓库里，本章不展开。

## 它为什么存在

CI 与本地环境的差异是排查成本的主要来源。复现脚本、容器化测试包装与环境采集共同压缩这个差异；格式与注册守卫则把"评审意见"前置成"提交前就失败"。

## 它和谁接

向上被开发者和 CI 直接调用，向下操作构建目录、测试驱动与文档站。它不改变被测代码，只改变"检查什么时候跑、跑完写到哪"。

## 代码位置

- `tools/format/clang_format.sh`、`.githooks/pre-commit`、`.github/workflows/format.yml` — 格式与钩子。
- `mkdocs.yml`、`.github/workflows/doc-deploy.yml`、`.github/workflows/doc-check.yml`、`docs/performance/methodology.md` — 文档站、PR 门禁与口径来源。
- `src/test/scripts/check_test_registration.py`、`.github/workflows/test.yml` — 注册守卫与 CI lane。

## 交付一句

第 6 块到此为止。6 块走完：接入 → 其它模型 → 测试 → 基准 → 验证路径 → 工具。下面的附录与风险清单按需查阅。

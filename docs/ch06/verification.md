---
title: 第 5 块：改动 → 验证路径
description: 按改动落点选验证命令的决策表：先分层，再取最小与全量两级。
outline: [2, 3]
---

## 它是什么

这一块是一张决策表：先判断改动落在哪层，再按"最小 → 全量"两级选命令。它把前两块的内容压成一条可执行的路径。

| 改了什么 | 先跑（最小） | 再跑（全量） |
| --- | --- | --- |
| `src/ps/rdma/*`、`rdma_protocol.h` | `ctest --test-dir build -R 'test_rdma_rc_protocol\|test_raw_verbs_allocator\|test_rdmaps_client_adapter'` | `ctest --test-dir build -L rdma_integration`，再 `run_benchmark_ps.py --transports rdma` |
| `src/storage/**`、`src/memory/**` | `ctest --test-dir build -R 'test_kvengine\|test_index\|test_kvengine_checkpoint\|test_ssd_layout\|test_ssd_allocators\|test_io_backend'` | `run_kvengine_compare.py --engines petkv dram_pet_dram dram_pet_tiered --workloads a b c`；改 tiering 时再跑 `run_tiered_cache_sweep.py` |
| `src/ps/base`、`src/ps/{grpc,brpc}` | `ctest --test-dir build -R 'test_ps_client_factory\|brpc_ps_server_unit_test\|test_ps_server_launcher\|test_shard_endpoint'` | `run_benchmark_ps.py --transports grpc,brpc`；改学习率透传时加 `test_recstore_client_py` |
| `src/base/report/**`、`observability` 配置 | `ctest --test-dir build -R test_report`（需 `USE_PERF_REPORT=ON`） | 用 `RECSTORE_REPORT_SINKS` 起一次真实上报，核对 `csv`/`jsonl` 产物 |
| `src/python/pytorch/recstore/ps_pipeline/**` | `PYTHONPATH=src/python/pytorch python -m unittest recstore.unittest.test_ps_pipeline recstore.unittest.test_ps_pipeline_dependency_split` | `ctest --test-dir build -R 'test_ps_pipeline_py\|test_ps_owner_native_py'`，再跑 loss 对齐两拓扑 |
| `src/python/pytorch/recstore/bagpipe_cache/**` | `PYTHONPATH=src/python/pytorch python -m unittest recstore.unittest.test_bagpipe_cache recstore.unittest.test_bagpipe_planned` | `rs_demo --read-mode bagpipe --optimization-plugin bagpipe --optimization-prescan` 的 e2e lane |
| `src/python/pytorch/recstore/optimizer.py`（含 Top-K） | `python -m pytest src/python/pytorch/recstore/unittest/test_sparse_sgd_topk_integration.py src/python/pytorch/recstore/unittest/test_topk_strict_prevalidation.py`（pytest 风格，ctest 未注册） | `test_sparse_optimizer_config_py` + 分布式 topk case + 稀疏精度对齐 |
| `src/python/pytorch/torchrec_kv/**` | `ctest --test-dir build -R test_torchrec_kv_fused_preload_py` | `python -m unittest recstore.unittest.test_fused_prefetch recstore.unittest.test_embedding_collection` |
| `model_zoo/rs_demo/**` | `ctest --test-dir build -R test_hierkv_rs_demo_py` | `ctest --test-dir build -R 'test_hierkv_rs_demo_py\|test_torchrec_kv_fused_preload_py'`，再按 skill 跑 e2e |
| `tools/benchmarks/**` | `python -m unittest src/test/scripts/test_run_benchmark_ps.py` 等对应自测 | `run_all.py --dry-run`，再真跑；改动 perf 注册表时先跑 `perf_suite_unit_py` |
| `docs/**`、`mkdocs.yml` | `mkdocs build --strict` | 看 doc-deploy workflow 的 strict 构建 |

## 它为什么存在

这个仓库的测试前置条件差异很大，随手跑全量会被硬件依赖卡住。按落点选最小集，是把"验证"从一次昂贵的仪式变成一次几秒钟的确认；只有改动跨层时，才需要往上加一档。

## 它和谁接

向上被开发者手工执行，向下调用第 3 块的测试与第 4 块的基准。它也是 CI 的定义来源，CI 只是把同样的命令按 lane 编排。

## 代码位置

- `.github/workflows/test.yml` — 三条 ctest lane 的 `-L`/`-LE` 与排除规则。
- `tools/ci/reproduce.sh` — 本地复现同一组 lane。
- `src/test/CMakeLists.txt` — 表里引用的测试目标名。

## 交付一句

第 5 块到此为止，读者应当能按落点直接挑命令。[第 6 块](./tooling)接工程工具，补齐 CI 之外的日常入口。

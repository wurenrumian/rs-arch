---
title: 风险、坑与未确认点
description: 按 commit 区间记录的已修复问题，以及仍然存在的坑与未确认点。
outline: [2, 3]
---

## 近期已修复（5f92ba2a → 6d205e98）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| `torchrec_dlrm` 顶层 import 指向不存在的 `python.pytorch.torchrec` | 改指 `python.pytorch.torchrec_kv.EmbeddingBag`，`test_torchrec_dlrm_imports_py` 守护 | `4d134e6b` |
| `test_cceh.cpp` 未编译 | `CCEH.cpp` 编进目标并注册，`storage;slow`、600 s、`RUN_SERIAL` | `942468d9` |
| `test_ssd_extendible_hash.cpp` 引用已删 API | 文件已删除 | `942468d9` |
| 测试文件可能静默漏注册 | 注册守卫 + `test_registration_consistency`，新增测试不注册即 CI 失败 | `942468d9` |
| torchrec 依赖测试分散且 CI 无 torchrec | 五模块合并为 `test_recstore_torchrec_py`，按 `import torchrec` 条件注册 | `e96b91cd` |
| `max_batch_keys_size` 散落在配置与驱动里 | 配置/驱动已删；`CachePS` 检测到仍打 WARNING 并忽略 | `5530c44a` |
| 没有可回归的性能门禁 | `perf_suite.py` + `cases.json` + 双标签 + 按机器基线 | `aea93f8b` |

## 本轮已修复（6d205e98 → 7c44f83da）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| tiered 拓扑没有 cache-on / cache-off 开关，读缓存配置只能手写 | `rs_demo --tiered-cache-policy {LRU,none}` 与 `benchmark/server.py` 的 `tiered_cache_policy` 一起把策略写进 `value.tiering.cache_policy`，非法值在参数校验阶段拒绝 | `e7ca11c5` |
| 没有多策略、多预算的 tiering 扫描脚本 | `tools/benchmarks/run_tiered_cache_sweep.py` 扫 policies × budget × SSD 比例，可关掉工作集检查；产物 `summary.csv` + `summary.md` | `a8c8de32`、`df0edc94` |
| tiered 的端到端数字没有可引用基线 | 新增 `docs/performance/tiered-e2e.md`（双机 RDMA、SSD 比例扫描），并显式标注 cache-off 口径 | `73ab4e2a`、`fd598b41` |
| 文档坏链只在部署时暴露 | 新增 `doc-check` workflow，PR 触及文档即 `mkdocs build --strict` | `4ccead0c` |
| `test_report` 只在 Debug 构建注册 | `USE_PERF_REPORT=ON` 即可编译并注册，覆盖 sink 选择与配置缓存失效 | `0d4247de` |

## 本轮已修复（7c44f83da → f8fde5af4）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| 基准只能回放二进制 key trace，无法直接用文本 query log，也没有名单生成工具 | `--read_trace_path`、`build_tiered_dram_profile.py` + `test_build_tiered_dram_profile_py` | `cb296098` |
| 基准里看不到在线准入与后台交换的开关，也没有进程峰值内存 | 新增 `--tiered_{dram_keys_path,online_admission,async_admission}`、`--load_batch_keys`，结果行带 `process_peak_rss_kb`，计时前 `ResetStats()`、收尾 `DrainBackgroundWork()` | `cb296098` |
| SSD 写侧没有计数，写放大只能靠推断 | 页写与 payload 字节进了 `ExtraResultFields()`，`test_ssd_allocators` / `test_ssd_static_layout_value_store` 直接断言页写数 | `8edd10be`、`2c107b30` |

## 本轮已修复（f8fde5af4 → 1f340167d）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| tiered 策略只能 `LRU` / `none` 二选一，e2e 默认值还把 cache-off 基线带偏 | `--tiered-cache-policy` 接受 `LRU` / `none` / `clock`，`rs_demo` 默认 `clock`、`benchmark/server.py` 模板默认 `none`；上游文档补了策略判据 | `571c6d51`、`170ddb17` |
| Python 侧没有上报入口，`KVClient` 自己写死 `build/lib/libreport.so` | `recstore.telemetry` 经 ctypes 复用 C++ reporter（缺库时静默返回 `False`），`rs_demo --report-metrics` 发 `e2e_step` 表；CSV / JSONL sink 跨进程行原子 | `9691f88d`、`0133f3ba`、`db92eb1a` |

## 仍存在

1. [源码事实] `--save-checkpoint` 仍不可用：`recstore_runner.py` 的 `from ..checkpoint import export_checkpoint` 指向不存在的模块；`checkpoint_all_ranks` 无消费者。可用入口是 `KVClient.save_checkpoint` / `load_checkpoint`。
2. [源码事实] 注册守卫不覆盖 `src/test/model_zoo/` 与 `src/test/scripts/`：`src/test/model_zoo/rs_demo/` 的 19 个测试里只有 `test_hybrid_dlrm`、`test_recstore_runner`、`test_runner_launcher`、`test_fused_preload`、`test_telemetry`、`test_e2e_metrics` 进 ctest，其余 13 个只能手工跑，回归风险仍在。
3. [源码事实] 守卫是文本级匹配：`test_f14_slab.cpp` 只出现在 `src/test/CMakeLists.txt` 的注释块里，却因名字出现而通过检查，实际未编译。
4. [待验证] e2e 驱动的 ctest 调用缺少 `--test-dir`：`e2e/custom/runner.py` 以 `cwd=ROOT` 执行 `ctest -R ...`，CI 与 coverage 都在 build 目录内执行；若仓库根没有 `CTestTestfile.cmake`，除 `--skip-tests` 外的前置校验等于空跑。
5. [源码事实] 硬件依赖：RDMA 相关需 `libibverbs` + 设备（否则 exit 77）；`petps_*` 需 `petps_server` 与 memcached；`benchmark_kv_engine` 的 SSD lane 需真实 NVMe 路径（默认 `/mnt/nvme1n1_recstore/recstore`）；`pytorch_client_test_rdma*` 需 memcached。
6. [源码事实] Top-K 压缩适用面窄：RDMA、非融合、`DistEmbedding` 组合在提交前全拒；benchmark 与 e2e 默认 `keep_ratio=1.0`，性能数字里不含 topk 收益。
7. [源码事实] 跨机默认地址写死：`tools/benchmarks/common.py` 的 `DEFAULT_REMOTE_HOST="shq@10.0.2.68"`、`DEFAULT_MASTER_ADDR="10.0.2.196"`，`runner.py` 还有 `wait_remote_ports('10.0.2.68', ...)`。换机器必须改代码或用 `--client-plan`/`--server-plan` 覆盖。
8. [源码事实] 遗留 smoke 脚本：`src/test/scripts/recstore_checkpoint_restart_smoke.py` 硬编码 `/workspace/run/...` 路径且未注册到 ctest，只能在特定容器里手工跑。
9. [源码事实] 文档漂移：`docs/performance/e2e.md` 说报告 p50 ms/step，实际 `e2e/custom/report.py` 输出 `p95_step_total_ms` 与各阶段均值；`examples/distributed_dlrm_training.py` 注释称接入 RecStore，实现里没有。
10. [源码事实] 基准默认值不一致：`run_benchmark_ps.py` 默认 `DRAM_EXTENDIBLE_HASH` + `PERSIST_LOOP_SLAB`，e2e 驱动与 e2e skill 默认 `DRAM_PET_HASH` + `PERSIST_LOOP_SLAB`，`run_kvengine_compare.py` 默认分配器 `CONCURRENT_SLAB_MEMORY_POOL`；tiered 侧 `rs_demo` 默认 `clock`、`benchmark/server.py` 模板默认 `none`，而 `run_benchmark_ps.py` 与 `run_tiered_cache_sweep.py` 的对照桶是 `none`。同层报数前必须在 `summary.md` 的 Workload 说明里对齐 index、allocator 与 `tiering.cache_policy`，否则"缓存开/关"会被当成算法差异。
11. [源码事实] 性能基线只有一个机器桶（`node190-intel-r-xeon-r-gold-5420`），其他机器 `--check` 只报 `no-baseline`；GitHub runner 永远不能产出可引用数字。
12. [源码事实] 基准驱动没跟进新开关：`run_kvengine_compare.py` / `run_tiered_cache_sweep.py` 都不传 `--tiered_dram_keys_path`、`--tiered_online_admission`、`--tiered_async_admission`、`--read_trace_path`，名单放置与在线准入只能手拼 `benchmark_kv_engine` 命令行，因此也没有统一的 `summary.csv` 产物。

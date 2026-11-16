---
title: 附：测试清单与基准清单
description: 按层分组的测试清单与基准清单，条件列只写跑起来的前提。
outline: [2, 3]
---

## 测试清单

按层分组；"条件"只写跑起来的前提。除 `test_f14_slab` 只在注释中出现外，`src/test/test_*.cpp` 都有可执行的 ctest 目标。

| 层 | 条目 | 覆盖的不变量 / 用途 | 条件 |
| --- | --- | --- | --- |
| storage | `test_kvengine` | PET hash 并发 size 与 batch set；`AllCombos` 覆盖 3 index × 3 value store × 3 allocator，含 bulk load、batch_get | CPU；SSD/tiered 用临时目录 |
| storage | `test_kvengine_checkpoint` / `test_petkv_unsupported` | checkpoint 目录往返、并发写与恢复；PetKV 的 Save/Load/clear 显式报错并返回 false | 临时目录 + 可写文件系统 |
| storage | `test_index` / `test_extendible_hash` / `test_hash_map` | index 层 put/get/覆盖/无 sink 的 batch_get；哈希结构 | CPU |
| storage | `test_storage_cache_lru` / `test_cceh` | 淘汰顺序、容量边界、并发安全、工厂拒绝未知策略；CCEH 基本读写（`CCEH.cpp` 编进目标） | CPU；`test_cceh` 为 `storage;slow`、600 s、`RUN_SERIAL` |
| storage | `test_concurrent_slab_memory_pool` / `test_r2_allocator` / `test_persist_loop_slab_allocator` | 三种 DRAM 分配器的分配、回收、计数 | CPU |
| storage | `test_ssd_layout` / `test_ssd_allocators` / `test_ssd_static_layout_value_store` | 文本/二进制日志一致、分区确定性、块/伙伴/slab 分配、静态布局 value store | CPU；内存 mock IO + 临时目录 |
| storage | `test_io_backend` / `test_io_uring_test_utils` | io_uring 读写与测试工具 | 需 io_uring；CI 用 `-E test_io_backend` 排除 |
| storage | `test_external_kv_engine` / `test_fasterkv_backend` / `test_hps_recstore_backend` / `test_raw_rocksdb_backend` | 第三方引擎适配 | 对应目标可构建时注册 |
| storage | `test_rectensor` / `test_optimizer` / `test_config` / `test_report` / `test_shm_file` / `test_hugectr_emb` | 所有权语义、AdamW/RowWiseAdaGrad、配置解析、报告、shm 文件、HugeCTR embedding | CPU |
| ps | `test_ps_client_factory` / `test_rdmaps_client_adapter` | 客户端工厂选择、RDMA adapter 行为 | CPU（假 transport） |
| ps | `test_rdma_rc_protocol` | RC 协议结构体大小/对齐、每 RPC key 数预算、PUT payload round-trip | 纯 CPU |
| ps | `test_rdma_control_plane` / `test_raw_verbs_allocator` | control-plane gRPC 服务注册与请求处理；verbs 内存注册/回收 | 需 `gRPC::grpc++` / libibverbs |
| ps | `test_shard_endpoint` / `test_ps_transport_benchmark` / `test_ps_server_launcher` | 单分片监听地址解析（默认回退、缺字段抛异常）；benchmark 配置校验；launcher CLI 与进程拉起 | CPU |
| ps | `test_brpc_ps_server`（`brpc_ps_server_unit_test`） | bRPC PS server 单元逻辑 | CPU；`ps_unit` |
| ps | `grpc_ps_client_test` / `dist_grpc_ps_client_test` / `brpc_ps_client_test` / `dist_brpc_ps_client_test` | 单机/分布式 gRPC、bRPC 客户端 | `ps_integration` |
| ps | `test_sparse_gradient_commit` / `test_bagpipe_metadata` | 分块提交幂等、失败不可重放、到达顺序、owner 合并位精确；超容量准入保留末行与 LRU 顺序 | CPU |
| ps | `petps_*` / `petps_fault_injection_driver_py` | 单/多 shard 值传输、lane 重建、owner 合并梯度、故障注入；场景表与 integration 源码一致 | `rdma_integration`、`SKIP_RETURN_CODE 77`；每 case 独立进程 |
| ps | `pytorch_client_test` / `pytorch_client_test_rdma*` | Python binding 全链路读写；RDMA basic/full/auto/descriptor | 需 `recstore_torch_ops`；RDMA 档需 memcached 或硬件 |
| e2e | `test_run_benchmark_ps_py` 等 `src/test/scripts/test_run_*` | 各基准驱动的参数与产物逻辑 | 纯 Python |
| e2e | `test_build_tiered_dram_profile_py` | DRAM 名单生成：frequency / density 排序、unseen 估计、fused 编码，非法 `fusion_k` 与越界升位拒绝 | 纯 Python（numpy） |
| e2e | `test_analyze_embupdate_stages` / `test_petps_cluster_runner` / `test_ps_server_{helpers,runner}` / `test_ps_test_config` | 分析脚本、集群 runner、PS 启动辅助 | 纯 Python |
| e2e | `test_recstore_config_schema_py` / `test_torchrec_dlrm_imports_py` / `perf_suite_unit_py` | 配置 schema（含废弃 `max_batch_keys_size` 的接受与忽略）、`torchrec_dlrm` 顶层 import、`cases.json` 解析与阈值判定 | 纯 Python |
| python | `test_hierkv_rs_demo_py` / `test_hierkv_python_ops_py` | rs_demo 的 hybrid DLRM、runner、launcher；本地 SHM 快路径、EBC/优化器单机多进程 | 需 HierKV ops |
| python | `test_torchrec_kv_fused_preload_py` / `test_ps_pipeline_py` | fused preload；无 TorchRec 也能 lookup、提交失败保留首个错误、取消的 wait 仍消费 native handle、空 rank marker、最后一步 drain | 后者 fake transport，`RECSTORE_DEFER_OPS_LOAD=1` |
| python | `test_ps_owner_native_py` / `test_hierkv_python_ops_with_torch_ops_py` | owner 合并计划/数学与 ticket 守卫；`test_hierkv_integration`、`test_multi_table_dims` | 仅在 `recstore_torch_ops` 存在时注册；部分 case 需 CUDA |
| python | `test_sparse_optimizer_config_py` / `test_sparse_update_mode_guard_py` | 客户端与服务端优化器配置匹配；同一 (client, table) 混用更新模式直接报错 | 纯 Python |
| python | `test_recstore_client_py` | `test_bagpipe_cache`、`test_dist_emb`、`test_embedding_collection`、`test_embedding_read_path`、`test_embeddingbag_prefetch_state`、`test_kvclient_native_distributed`、`test_logical_shard_router`、`test_prefetch_strict_mode`、`test_single_node_exchange` | 部分 case 需 CUDA / `PS_SERVER_PATH` |
| python | `test_recstore_torchrec_py` | `test_bagpipe_planned`、`test_fused_prefetch`、`test_shared_fused_namespace`、`test_sparse_optimizer_staging`、`test_step_consistency` | 仅在 `import torchrec` 成功时注册 |
| python | `test_ebc_precision_py` / `test_gpu_cache_py` | EBC 与原生 TorchRec EBC 的逐位对齐（单进程/两进程）；GPU cache profile 与 hit-only 快路径 | 需 torchrec / CUDA；CUDA case skip |
| python | pytest-only / manual（`test_topk_*`、`test_sparse_sgd_topk_*`、`test_gradient_compression`、`test_ebc_precision*` runner） | Top-K 压缩的适用面与"提交前全拒"、EBC 手动 runner | 见 `EXEMPT`；部分需 `RECSTORE_TOPK_NATIVE_TEST=1` |
| python | `src/test/model_zoo/rs_demo/` 其余 13 个 | `test_torchrec_*`、`test_report_runtime`、`test_timing`、`test_dlrm_source`、`test_server_ports`、`test_hybrid_config`、`test_recstore_distributed`、`test_hps_torch_embedding` | 未注册，只能手工 `python -m unittest` |

## 基准清单

- **storage**：`benchmark_kv_engine`（YCSB workload、`--read-mode {exists,get,batch_get_flat}`、`--report-latency`、`--report-stages`、`--read_trace_path` / `--load_batch_keys`、`--tiered_dram_keys_path` / `--tiered_online_admission` / `--tiered_async_admission`）；`run_kvengine_compare.py`（`--engines` 默认 `petkv dram_pet_dram dram_pet_tiered`，可选 `fasterkv`、`fasterkv_ssd`、`hps_rocksdb`；`--workloads`、`--distributions`、`--batch-keys`、`--record-count`、`--runtime-seconds`、`--threads`）；`build_tiered_dram_profile.py`（名单生成）；`run_storage_backend_compare.py`、`run_hps_backend_compare.py`、`run_hps_tiered_ratio_compare.py`、`run_ssd_layout_microbench.py`；`tools/benchmarks/batch_test/`（SSD 密集扫描旁支，自带 README）。
- **ps_transport**：`ps_transport_benchmark`、`rdma_rc_transport_benchmark`、`recstore_mixed_benchmark`、`benchmark_client`、`backend_benchmark`（`src/benchmark/CMakeLists.txt`）；`run_benchmark_ps.py`（local/ssh、RDMA 专项开关、缺省输出 `results/benchmark_ps_<MMDDHHMM>`）、`run_ps_dram_transport_benchmark.py`、`run_rdma_rc_transport_benchmark.py`、`run_rdma_transport_benchmarks.py`；`run_local_shm_mixed_benchmark.py`、`run_hierkv_recstore_mixed_benchmark.py`。
- **e2e**：`e2e/custom/cli.py` + `runtime.py` + `runner.py` + `report.py`（`criteo_kaggle/bench_compare.py` 是它的封装）；`e2e/run_two_node_rdma_compare.sh`（默认 local `10.0.2.192/GPU3`、remote `10.0.2.191/GPU0`、PS 端口 15000、输出 `results/e2e_<MMDDHHMM>`，开跑前先跑 `petps_*` 相关 ctest）；lane 入口 `run_all.py`、`run_main_results.py`、`run_stage_breakdown.py`、`run_recstore_chain.py`，产物汇总 `summary/raw_metrics.{json,csv}` 与 `aggregated_metrics.csv`。
- **perf**：`perf_suite.py`（`run` / `ab` / `aggregate` / `env`）、`perf/cases.json`、`perf/baselines/<env-id>/`、`perf/README.md`、`perf/test_perf_suite.py`。

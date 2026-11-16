---
title: 证据索引
description: 按训练接入、其它模型、测试、基准、工程工具分组的证据索引。
outline: [2, 3]
---

**训练接入**

- `model_zoo/rs_demo/cli.py#main`/`#build_runner`；`config.py#RunConfig`（`read_mode=prefetch`、`ps_type=BRPC`、`batch_size=4096`、`steps=80`、`seed=20260330`）。
- `runners/recstore_runner.py#_build_read_path`/`#_run_local_worker`、`runtime/timing.py#StepTimer`、`runtime/validation.py#export_validation_state`。
- `runners/recstore_runner.py:1073`（`from ..checkpoint import export_checkpoint`，模块不存在）；`src/python/pytorch/recstore/KVClient.py#save_checkpoint`/`#load_checkpoint`。
- `src/python/pytorch/recstore/optimizer.py#SparseSGD`；`ps_pipeline/pipeline.py#PSPipelineSGD`。

**其它模型**

- `model_zoo/torchrec_dlrm/run_single_day.sh`、`tests/dlrm_main_single_day.py`、`tests/dlrm_main_torchrec_single.py`；`dlrm_main.py:45`（`python.pytorch.torchrec_kv.EmbeddingBag`）。
- `model_zoo/criteo_kaggle/README.md`、`bench_compare.py`、`start_rdma_ps.py`；`model_zoo/tensorflow_dlrm/recstore_embedding_layer.py`、`client.py`；`examples/distributed_dlrm_training.py`（无 RecStore 引用）。

**测试**

- `src/test/CMakeLists.txt#add_python_unittest`/`#add_recstore_unittest`、`#test_cceh`（`storage;slow`/600 s/`RUN_SERIAL`）、`#test_recstore_torchrec_py`（`import torchrec` 条件）、`#perf_smoke_*`。
- `src/test/scripts/check_test_registration.py#EXEMPT`、`test_torchrec_dlrm_imports.py`、`test_recstore_config_schema.py`；`.github/workflows/test.yml`（`-LE "python|rdma_integration|^perf$"`）；`tools/ci/reproduce.sh`。

**基准**

- `src/benchmark/CMakeLists.txt`、`src/storage/kv_engine/CMakeLists.txt`；`ps_transport_benchmark.cc#PrintTransactionResult`；`benchmark_kv_engine.cc`。
- `tools/benchmarks/perf_suite.py`、`perf/cases.json`、`perf/README.md`、`perf/baselines/node190-intel-r-xeon-r-gold-5420/`。
- `run_benchmark_ps.py#parse_args`/`:530`（`tiering.cache_policy=none`）；`run_kvengine_compare.py#parse_args`；`e2e/custom/cli.py#--index-type`、`runtime.py:78`。
- `tools/benchmarks/build_tiered_dram_profile.py#build_profile`（名单生成）；`benchmark_kv_engine.cc` 的 `--tiered_dram_keys_path` / `--tiered_online_admission` / `--tiered_async_admission` / `--read_trace_path` / `--load_batch_keys`。
- `common.py#DEFAULT_REMOTE_HOST`/`#DEFAULT_MASTER_ADDR`/`#DEFAULT_STEPS=12`/`#DEFAULT_WARMUP_STEPS=2`；`runner.py:101`。

**工程工具**

- `tools/format/clang_format.sh`、`.githooks/pre-commit`、`.github/workflows/format.yml`；`mkdocs.yml`、`.github/workflows/doc-deploy.yml`、`docs/performance/methodology.md`。

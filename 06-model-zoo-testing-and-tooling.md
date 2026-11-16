---
tags: [architecture, testing]
---

## 阅读地图

### 一句话

这一章是入口地图：把 RecStore 接进一个训练循环要动哪几处，以及改完之后按什么顺序跑，才能说"没坏"。

### 6 个部件

| 编号 | 短名 | 它负责回答的问题 |
|------|------|------------------|
| 1 | 训练接入 | 一个 step 里，查询、梯度回写、优化器更新、检查点分别接在哪 |
| 2 | 其它模型与例子 | 除主入口外还有哪些训练脚本，各自到底接没接 RecStore |
| 3 | 测试地图 | 哪个测试覆盖哪条不变量，跑起来要什么前置条件 |
| 4 | 基准地图 | 指标按哪三层拆，产物长什么样，驱动脚本怎么选 |
| 5 | 验证路径 | 按改动落点，最小验证集与全量验证集分别是什么 |
| 6 | 工程工具 | CI、格式、注册守卫各自从哪进 |

### 它们怎么串起来

想接入新模型，先看部件 1，那里有一个 step 的完整接入顺序；想确认某个现成脚本是不是真的在用 RecStore，查部件 2。改完代码不确认范围时，走部件 5：它把"改了什么"映射到"先跑哪条命令"，被引用的测试与基准分别是部件 3 和部件 4。部件 6 是外围：CI 把部件 3、4 串成流水线。

### 核心概念表

| 概念 | 一句话 |
|------|--------|
| 接入点 | 训练循环里与存储交互的那几行代码 |
| 读路径 | 查询怎么发出去、梯度怎么回来的那套策略 |
| 提交与刷新 | 稀疏梯度先提交成句柄，再统一等待的两段式 |
| 验证网 | 从单元测试到集成测试的分层测试集合 |
| 层 | 基准的三档口径：存储、PS 传输、端到端 |
| lane | 一组固定步数与参数的基准运行单元 |
| 注册 | 测试文件进入 ctest 名单；没注册的必须显式豁免 |

### 建议读法

- 要把某个新模型接进来：第 1 块 → 第 2 块，对照现有脚本改。
- 改完代码不知道跑什么：第 5 块 → 第 3 块，按落点补齐。
- 要出可比较的性能数字：第 4 块 → 第 6 块，先对齐口径再报数。

### 范围与不在范围

在范围内：`model_zoo/` 下四个训练入口、`examples/`、`src/executable/` 的接入程度；C++ 与 Python 测试地图；基准体系（可执行文件、驱动脚本、产物、报告格式）；工程工具（CI 复现、格式、文档站、注册守卫）。不在范围内：计算层算子内部（02 章）、PS 协议与传输（03/04 章）、存储引擎内部（05 章）、具体性能数字（本仓库要求文档不复述易过期数字，见 `docs/performance/methodology.md`）。

## 第 1 块：训练接入

### 它是什么

仓库里有一个自带后端的演示训练工程，它同时承担三件事：起停参数服务器、跑一个完整的 DLRM 训练循环、把每个阶段的耗时写成 CSV。它是"怎么接"的参考实现，也是端到端基准的被执行程序。

### 它为什么存在

接入 RecStore 要处理的是一串有顺序的请求：查询要在前向之前发出，梯度要在反向之后提交，提交之后还要有一个显式等待，检查点必须在所有提交落地之后才能拍。演示工程把这些顺序固化成一条可跑的循环，新模型照抄这条顺序即可，不必重新推导。

### 它和谁接

向上被 CLI 与基准驱动脚本调用，向下通过 Python 绑定落到 PS，再由 PS 落到存储。它自己不实现存储语义，只决定"什么时候发什么请求"。

#### 子块 1.1：启动链

一次后端运行的分层顺序（`model_zoo/rs_demo/cli.py#main`）：

1. `parse_config` 解析 CLI 或 `--run-config-json`，`populate_default_paths` 填默认输出路径；
2. `validate_recstore_config` / `validate_torchrec_config` / `validate_hps_torch_config` 做交叉约束校验（例如 `read_mode=ps_pipeline` 必须 `plugin=none`、无 GPU cache、无 prescan、且开启 embedding fusion）；
3. `make_runtime_dir` 生成 `recstore_config.json`（含 `ps_type`、KV 容量、`value_size_bytes = embedding_dim * 4`、index 类型；`ps_kv_backend=recstore_tiered` 时还写 DRAM 容量倍率与 `value.tiering.cache_policy`），并把路径写进 `RECSTORE_CONFIG`；`--tiered-cache-policy` 接受 `LRU` / `none` / `clock`，默认 `clock`（主放置交换），只有 `none` 才是 cache-off 基线；
4. 需要时 `start_server`（RPC/SHM）或 `start_rdma_server_cluster`（RDMA，额外注入 `RECSTORE_RDMA_*` 环境变量）；
5. `build_runner(...).run(...)`：单进程直接进 `_run_local_worker`，多进程走 `BenchmarkRunner._run_distributed`，用 `torch.distributed.run` 重新拉起 `run_mock_stress.py`，每个 rank 读同一份 `worker_config.json`；
6. rank 把行写入 `rank<N>.csv`，主进程 `_merge_rank_csvs` 合成 `recstore_main.csv`，随后 `cli.py` 调 `analyze_embupdate` 生成 `recstore_embupdate.csv`。

#### 子块 1.2：读路径选择

建读路径的那一步决定"查询怎么发、梯度怎么回"，四种模式各有硬约束。

| `--read-mode` | 实现 | 关键约束 |
| --- | --- | --- |
| `direct` | `DirectReadPath` | 同步查询；`prefetch_depth` 被忽略（runner 会打印提示） |
| `prefetch` | `PrefetchReadPath` | 深度由 `--prefetch-depth` 控制 |
| `bagpipe` | `BagPipeReadPath` + `OptimizationPluginRegistry.create("bagpipe")` | 自动把 `optimization.plugin` 设为 `bagpipe`；`prescan` 需显式开启 |
| `ps_pipeline` | `PSPipeline` 或 `GPUOwnerPipeline` | 必须 fusion、`plugin=none`、无 GPU cache、无 prescan；GPU owner 还需 RDMA + `--dense-cuda-graph` |

`ps_pipeline` 的早期提交由 `PSPipelineSGD.submit_pooled_grad` 挂到 `embedded_sparse` 的 autograd hook 上（`--ps-pipeline-early-submit`），否则在 step 内用 `record_pooled_grad(sparse_grad)` 显式记录。

#### 子块 1.3：一个 step 的接入点

本地 worker 的循环顺序与对应符号：

| 顺序 | 阶段 | 代码接入点 | 计时列 |
| --- | --- | --- | --- |
| 1 | 取 batch + 元数据 | `prepare_next_batch`、`read_path.on_batch_prepared` / `queue_cpu_metadata` | `batch_prepare_ms`、`input_pack_ms` |
| 2 | embedding 查询 | `read_path.before_lookup` → `read_path.lookup` / `plugin._controller.lookup` / `embedding_module(features)` | `embed_lookup_ms` |
| 3 | 结果整形 | `reshape_torchrec_embeddings_for_dlrm`、`prepare_hybrid_dlrm_input` | `embed_pool_local_ms`、`output_unpack_ms` |
| 4 | dense fwd/bwd | `compute_dense_loss`（或 `dense_graph(...)` 整图） | `dense_fwd_ms`、`backward_ms`、`dense_graph_ms` |
| 5 | 稀疏梯度回写 | `record_pooled_grad` → `sparse_optimizer.step()` → `sparse_optimizer.flush()` → `read_path.after_sparse_update` | `sparse_backward_replay_ms`、`sparse_optimizer_step_ms`、`sparse_optimizer_flush_ms` |
| 6 | dense 优化器 | `dense_optimizer.step()` + `zero_grad(set_to_none=True)` | `dense_optimizer_ms` |
| 7 | 收尾 | `timer.finish()`、`read_path.after_step_sync`、`finalize_recstore_row` | `step_sync_wait_ms`、`step_total_ms` |

三条关键事实可以直接对照源码验证：

- 三种 backend 的学习率都硬编码为 `0.01`：`RecStoreRunner._build_training_modules` 的 dense SGD 与 `SparseSGD`、`TorchRecRunner._run_single_or_dist_worker` 的 dense/sparse SGD、`HpsTorchRunner` 的 dense SGD 都是 `lr=0.01`（HPS 的稀疏更新在 LookupLayer 内部，`sparse_optimizer_ms` 记 0）；`RunConfig` 没有 `--learning-rate` 字段。loss 对齐脚本因此不需要同步 lr。
- 稀疏更新是"提交 + 等待"两段式：`SparseSGD.step` 在通用路径把 update 放进 `_inflight_handles`（local_shm 单表与单机分布式 fast path 则同步写入 `_last_update_payloads`），`flush()` 对 in-flight handle 逐个 `kv_client.wait(handle)` 并计入 `update_flush_wait_ms`。读后写可见性靠 `flush` 与 `read_path` 的提交顺序保证，不靠 step 边界。
- 每个 stage 的 GPU 计时用 `StepTimer.gpu`（CUDA event），host/网络阶段用 `StepTimer.cpu`（wall clock）；`finish()` 只做一次 `torch.cuda.synchronize`，把 straggler 等待单独记为 `step_sync_wait_ms`。

除了 CSV 行，`--report-metrics` 会把 `_E2E_STEP_METRICS` 的 13 列以 `e2e_step` 表发进观测 sink：`recstore.telemetry.emit()` 经 ctypes 调 `libreport.so` 的 `report()`，与 C++ 调用点共用 `remote`/`csv`/`jsonl`/`glog`；`uid` 形如 `<run_id>|step<N>`，只有 rank 0 发，库不存在时 `available()` 为 `False`、`emit()` 返回 `False` 而不抛。连续循环的 `loss` 要等末尾读回，届时按 `names=("loss",)` 单独补发。

#### 子块 1.4：checkpoint 的真实入口

真正可恢复的快照在 PS 侧，不在 runner 里：

- `KVClient.save_checkpoint(path, metadata)` 先 `flush_async_updates()`，再把 metadata 当 JSON 校验（必须含 `identity` 与 `checkpoint_id`），最后调用 ops 的 `save_checkpoint`。
- `KVClient.load_checkpoint` 拒绝存在 pending async op 的客户端，成功后清 GPU cache。
- 训练侧诊断快照是 `runtime/validation.py#export_validation_state`（`--validation-state`），文件里显式标注"diagnostic snapshot, not a resumable training checkpoint"。

> 文档与代码不一致：`recstore_runner.py#_run_local_worker` 的 `--save-checkpoint` 分支执行 `from ..checkpoint import export_checkpoint`，但 `model_zoo/rs_demo/` 下仍不存在 `checkpoint.py`；`--checkpoint-all-ranks` 只在 `config.py` 定义，没有消费者。该 CLI 路径当前不可用，checkpoint 只能走 `KVClient.save_checkpoint`。

### 代码位置

- `model_zoo/rs_demo/cli.py#main`、`#build_runner`、`#make_runtime_dir` — 启动顺序、`RECSTORE_CONFIG` 注入、RDMA 集群起停。
- `model_zoo/rs_demo/runners/base.py#BenchmarkRunner._run_distributed`、`#_merge_rank_csvs` — torchrun 骨架与 rank CSV 合并。
- `model_zoo/rs_demo/runners/recstore_runner.py#RecStoreRunner._build_read_path`、`#_run_local_worker` — 读路径分支与 step 循环。
- `src/python/pytorch/recstore/optimizer.py#SparseSGD.step`、`#flush` — 提交与刷新。
- `src/python/pytorch/recstore/KVClient.py#RecStoreClient.save_checkpoint`、`#load_checkpoint` — 检查点契约。

### 交付一句

第 1 块到此为止，读者应当能照抄这条循环把新模型接上，并知道检查点只能走客户端那条路。第 2 块接其它模型与例子，清点哪些脚本真的在用这套东西。

## 第 2 块：其它模型与例子

### 它是什么

除主入口外，仓库里还有三条完整训练路径和一批早期脚本。接入程度差别很大：有的走自研 embedding 模块，有的只做对照，有的与 RecStore 无关。

### 它为什么存在

对外演示需要"同一份数据、两种后端"的对照，也需要覆盖 TorchRec 与 TensorFlow 两种生态。这带来一个副作用：同名脚本的接入状态不一致，读者容易按文件名的字面意思误判。

### 它和谁接

它们上接各自的训练脚本入口，下接同一套 Python 绑定；共享的是 embedding 模块与稀疏优化器，不共享训练循环。

| 模型 / 例子 | 入口 | 接 RecStore？ | 备注 |
| --- | --- | --- | --- |
| `rs_demo` | `run_mock_stress.py` → `cli.py` | 是 | 主参考实现；三种 backend（RecStore / TorchRec / HPS Torch）都 `lr=0.01` |
| `torchrec_dlrm` custom | `run_single_day.sh` → `tests/dlrm_main_single_day.py` | 是 | `RecStoreEmbeddingBagCollection` + `SparseSGD`，每步 `zero_grad → forward → backward → validate_config → step → flush` |
| `torchrec_dlrm` 对照 | 同上 `--torchrec` → `tests/dlrm_main_torchrec_single.py` | 否 | 原生 `EmbeddingBagCollection` + `DistributedModelParallel` + `EmbeddingShardingPlanner` |
| `torchrec_dlrm/dlrm_main.py` | 直接运行 | 是（import 已修） | 顶层 `from python.pytorch.torchrec_kv.EmbeddingBag import ...`；`run_single_day.sh` 不调用它，`test_torchrec_dlrm_imports_py` 守护 |
| `criteo_kaggle` 全量 | `run_recstore.sh` / `run_torchrec.sh` | 前者是 | 出 val AUC，默认 2 epoch；`recstore_config.json` 两 shard RDMA |
| `criteo_kaggle` 短步 | `bench_compare.py` | 是 | 调 `tools.benchmarks.e2e.custom.cli`，拓扑只来自自己的 `--clients`/`--ps`，不读 `cluster.sh` |
| `tensorflow_dlrm` | `train.py` + `client.py` | 是 | Keras 层里用 `emb_read`/`emb_update` 手写 `tf.custom_gradient`，没有稀疏优化器抽象 |
| `examples/distributed_dlrm_training.py` | `python examples/...` | 否 | 原生 EBC，注释称接入 RecStore，实际没有；`sys.path` 硬编码作者机器路径 |
| `src/executable/*` | `perf_emb.py` 等 | 部分 | 早期性能脚本，依赖 `pyinstrument`/`debugpy`，不在 CI 与基准驱动里 |

`torchrec_kv/` 只提供被复用的 embedding 模块本体（`EmbeddingBag.py`、`EmbeddingCollection.py`、`fused_preload.py`），不含训练循环；`recstore.__init__` 通过 `__getattr__` 懒加载 `RecStoreEmbeddingBagCollection`。TF 侧 `client.py` 默认加载 `build/lib/lib_recstore_tf_ops.so`，路径相对仓库根解析。

### 代码位置

- `model_zoo/torchrec_dlrm/run_single_day.sh` — `CUSTOM_SCRIPT` / `TORCHREC_SCRIPT` 的选择。
- `model_zoo/torchrec_dlrm/tests/dlrm_main_single_day.py`、`#dlrm_main_torchrec_single.py` — 两条对照路径。
- `model_zoo/criteo_kaggle/README.md`、`#bench_compare.py`、`#start_rdma_ps.py` — 两套入口与短步驱动。
- `model_zoo/tensorflow_dlrm/recstore_embedding_layer.py`、`#client.py` — TF 绑定。

### 交付一句

第 2 块到此为止，读者应当知道"目录里有的脚本"与"真正接进来的脚本"不是一回事。第 3 块接测试地图，说明这些路径各自被什么测试守住。

## 第 3 块：测试地图

### 它是什么

验证网分两层：C++ 侧由测试框架驱动，目标定义在构建文件里；Python 侧以模块为单位，一部分被注册进同一个驱动，其余靠脚本或人工运行。组织原则是"测试文件对应一组不变量"。

怎么用这一块：先跑 `ctest` 三条 lane 判断自动覆盖是否通过；再按改动落点查附录里的测试条目，确认有没有对应的不变量；新增测试则先过注册守卫，再进 lane。

| 入口 | 用途 |
| --- | --- |
| `ctest --test-dir build -LE "python\|rdma_integration"` | 单测 lane（CI 再加 `^perf$`） |
| `ctest --test-dir build -L python` | Python lane |
| `ctest --test-dir build -L rdma_integration` | RDMA 集成 lane，无硬件时 exit 77 |
| `test_registration_consistency` | 新增测试是否注册或豁免的守卫 |

### 它为什么存在

[推断] 这套系统的失效方式很少表现为崩溃，更多是"数值还对但顺序错了"或"路径悄悄退化成慢路径"。所以测试按不变量组织：提交幂等、到达顺序、所有权语义、位精确对齐。

### 它和谁接

向上被 CI 与本地复现脚本调用，向下依赖构建产物与外部条件（CUDA、RDMA 网卡、io_uring、临时目录）。跑不起来的测试大多缺前置条件，问题通常不在逻辑。

#### 子块 3.1：注册守卫

`src/test/scripts/check_test_registration.py` 扫描 `src/test/test_*.cpp` 与 `src/python/pytorch/recstore/unittest/test_*.py`。规则：文件名必须出现在任意 `CMakeLists.txt`，否则必须在脚本的 `EXEMPT` 里写明原因。`test_registration_consistency`（`meta;python`）随 python lane 执行，所以**新增测试若既不注册也不豁免，CI 会直接失败**。

存量豁免共 10 条：5 个 pytest-only 模块（`test_gradient_compression`、`test_sparse_sgd_topk_{backend,distributed,integration}`、`test_topk_strict_prevalidation`）、4 个手动 runner（`test_ebc_precision`、`test_ebc_precision_{distributed_runner,multiprocess}`、`test_sparse_sgd_topk_gloo`）、1 个 stale（`test_gpu_training_cache`）。脚本同时把"已注册却仍在豁免表"报为 stale，防止豁免表腐烂。

注意守卫的匹配是文本级的，且范围不含 `src/test/model_zoo/` 与 `src/test/scripts/`：注册与豁免只对上面两个目录生效。

#### 子块 3.2：本轮新增与变更

- `test_cceh` 已注册：`CCEH.cpp` 直接编进测试目标，标签 `storage;slow`、600 s、`RUN_SERIAL`。`test_ssd_extendible_hash.cpp` 已删除（引用已不存在的 API）。
- torchrec 依赖的五个 Python 模块（`test_bagpipe_planned`、`test_fused_prefetch`、`test_shared_fused_namespace`、`test_sparse_optimizer_staging`、`test_step_consistency`）合并为一个 ctest 项 `test_recstore_torchrec_py`，只在 `python -c "import torchrec"` 成功时注册；失败时 CMake 打印跳过原因。
- `add_recstore_unittest` 统一设置 `PYTHONPATH=src/python/pytorch`、cwd 为仓库根；`add_python_unittest` 只设 cwd。注册 Python 包内模块时用前者，注册脚本文件时用后者。
- 新增守护测试：`test_petkv_unsupported`（PetKV 的 checkpoint 显式不支持）、`test_shard_endpoint`（单分片监听地址解析）、`test_torchrec_dlrm_imports_py`（import 路径）、`perf_suite_unit_py`（`test_perf_suite`）。
- 本轮（`6d205e98` 之后）增加的覆盖：`test_report` 不再要求 Debug 构建，`USE_PERF_REPORT=ON` 时即可编译，覆盖 sink 选择与环境变量覆盖；`test_ssd_allocators` / `test_io_backend` 扩到批量窗口、页去重、写失败回滚；`test_ssd_static_layout_value_store` 扩到 CLOCK 交换、异步交换、四种策略选择；Python 侧新增 `test_sharded_update_async_lr` 并注册进 `test_recstore_client_py`；`test_server_ports.py` 覆盖 `--tiered-cache-policy` 的注入与非法值拒绝（该目录不在注册守卫范围内，仍未进 ctest）。
- 本轮（`7c44f83da` 之后）增加的覆盖：`test_ssd_static_layout_value_store` 扩到在线准入（`OnlineAdmission*`：回滚、并发写不被覆盖、staging 余量、合并大请求、范围接口回退）与异步准入（`AsyncAdmission*`：陈旧快照、失败传播、只读请求排空），并断言非法重复批次不写任何一行；`test_ssd_allocators` 开始校验 `GetWriteStats()` 的页写与字节；新增 `test_build_tiered_dram_profile_py`（`add_python_unittest`）。
- 本轮（`f8fde5af4` 之后）增加的覆盖：`test_telemetry`（`add_python_unittest`，标签 `python;telemetry`）覆盖 `telemetry.py` 的候选库排序、`RECSTORE_REPORT_LIBRARY` 覆盖与 `emit` 的缺库降级；`test_e2e_metrics`（`add_recstore_unittest`，同标签）覆盖 `--report-metrics` 发出的 `e2e_step` 行（含终局 loss 补发）；`test_report.cpp` 扩 50 行，覆盖 CSV / JSONL sink 的跨进程行原子。

#### 子块 3.3：运行方式与标签

```bash
# 单测 lane（CI 用 -LE "python|rdma_integration|^perf$"）
ctest --test-dir build --output-on-failure -LE "python|rdma_integration"
# Python lane
ctest --test-dir build --output-on-failure -L python
# RDMA 集成 lane（无硬件时自动 skip，exit 77）
ctest --test-dir build --output-on-failure -L rdma_integration
# 单点复现
ctest --test-dir build -R test_kvengine --output-on-failure
```

标签族：`python`、`storage`、`storage;slow`、`local_shm`、`rdma_integration`、`ps_integration`、`ps_unit`、`hierkv`、`integration`、`torch_ops`、`hugectr`、`ebc`、`gpu`、`rs_demo`、`optimizer`、`sparse`、`bagpipe`、`torchrec`、`torchrec_kv`、`config`、`meta`、`perf_smoke`。资源属性另有 `RUN_SERIAL`、`RESOURCE_LOCK`（`local_shm_tests`、`gpu_tests`、`perf_smoke`）与 `SKIP_RETURN_CODE 77`。Python 模块手工运行时需要 `PYTHONPATH=src/python/pytorch`（ctest 项已内置）。

### 代码位置

- `src/test/CMakeLists.txt#add_python_unittest`、`#add_recstore_unittest`、`#add_test` — 注册表。
- `src/test/scripts/check_test_registration.py` — 注册守卫与 `EXEMPT`。
- `src/ps/rdma/CMakeLists.txt#add_petps_owner_test` — 多 shard owner 测试族。
- `src/framework/CMakeLists.txt` — `pytorch_client_test*` 的 env 与 `SKIP_RETURN_CODE 77`。
- `src/python/pytorch/recstore/unittest/` — Python 侧全部模块。

### 交付一句

第 3 块到此为止，读者应当知道哪一层测试是自动的、哪一层要手工跑，以及新增测试为什么会被守卫拦住。第 4 块接基准地图，把这些测试守不住的性能问题交给三层口径。

## 第 4 块：基准地图

### 它是什么

基准按被测对象分三层，每层有独立的驱动脚本、独立的口径和独立的产物，互相不能替代。自 `aea93f8b` 起，还有一层"注册式性能套件"把其中可回归的用例变成有基线的门禁。

| 层 | 驱动 | 被测二进制 | 主要指标 | 产物 |
| --- | --- | --- | --- | --- |
| storage-only | `run_kvengine_compare.py` | `benchmark_kv_engine` | 吞吐、p50/p90/p99/max、BatchGetFlat 阶段 | `summary.csv`、`kvengine_*_summary.csv`、`*.svg`、`logs/`、`data/` |
| ps_transport | `run_benchmark_ps.py` | `ps_transport_benchmark` | `elapsed_us_*`、`ops_per_sec`、`key_ops_per_sec`（load/measure 两阶段） | `summary.csv`、`summary.md`、`run_config.json`、每 client 日志 |
| e2e | `e2e/custom/cli.py`（或 `bench_compare.py`） | `run_mock_stress.py` + PS | `samples_per_sec`、`p95_step_total_ms`、`lookup/update_mrows_per_sec`、13 项阶段均值 | `summary.md`、`summary_e2e.csv`、`manifest.csv`、`deployment.md`、`commands.sh`、`outputs/` |

### 它为什么存在

[推断] 三层的失效原因不同：存储层在分配器与索引，网络层在传输与分片，端到端层可能在步进同步。混层比较会得到"改了 A 却让 B 变慢"的错误结论，所以报告必须写明层号。

### 它和谁接

向上被验证路径引用，向下调用 C++ 基准二进制与训练脚本。端到端那层还会拉起参数服务器，所以它同时依赖 03–05 章的部署前提。

#### 子块 4.1：注册式性能套件

`tools/benchmarks/perf/cases.json` 是唯一参数、指标与噪声阈值来源，`tools/benchmarks/perf_suite.py` 只负责执行它。两个标签分工明确：

| 标签 | 跑在哪 | 目的 |
| --- | --- | --- |
| `perf_smoke` | 普通 ctest lane，含 GitHub CI | 极小规模金丝雀：二进制能起、指标能解析；不比数字 |
| `perf` | 自有硬件（node190/191） | 带 `repeats` 与基线比较的真实测量；CI 用 `-LE "^perf$"` 排除 |

`perf_smoke` 用例已注册为 ctest 项（`perf_smoke_kvengine_c_read`、`perf_smoke_kvengine_a_mixed`、`perf_smoke_ps_local_shm_fetch`，`RESOURCE_LOCK perf_smoke`）；`perf` 用例不注册，只能显式运行。目前 `perf` 用例有 4 个（`kvengine_c_read_full`、`kvengine_a_mixed_full`、`kvengine_tiered_scramble`、`ps_local_shm_fetch_full`），`layer` 字段允许 `e2e`，但暂无 e2e 用例。

命令以 `tools/benchmarks/perf/README.md` 为准：

```bash
# CI 金丝雀（CPU，约 5 s）
python3 tools/benchmarks/perf_suite.py run --label perf_smoke
# 自有硬件：重复采样并与基线比较
python3 tools/benchmarks/perf_suite.py run --label perf --repeats 3 --check
# 显式录基线（diff 需人工审阅）
python3 tools/benchmarks/perf_suite.py run --label perf --repeats 3 --write-baseline
# 同一机器上交错 A/B 两个 build 或两组参数
python3 tools/benchmarks/perf_suite.py ab --case kvengine_c_read_full --a-build /tmp/base-build --b-build ./build --check
```

基线按机器分目录：`baselines/<env-id>/<case-id>.json`，`env-id` 默认 `<hostname>-<cpu-model>`，仓库里已提交的参考桶是 `node190-intel-r-xeon-r-gold-5420`。**不能跨机器比**；`--check` 对没有桶的机器报 `no-baseline` 而不是失败，CPU 频率与基线差超过 15% 时报 `env-mismatch`，同一次运行内 repeats 超过噪声阈值时报 `unstable` 且不设门禁。退出码：0 正常、1 执行错误、2 超出噪声阈值的回归。产物在 `results/perf_<MMDDHHMM>/`：`metrics.json`、`summary.md`、`env.json`、`logs/`、`work/`。

#### 子块 4.2：驱动脚本与默认值

- `run_benchmark_ps.py`：默认 `--transports rdma,grpc,brpc`、`--index-type DRAM_EXTENDIBLE_HASH`、`--dram-allocator PERSIST_LOOP_SLAB`、`--value-store-type DRAM_VALUE_STORE`；生成的配置把 `value.tiering.cache_policy` 设为 `none`。拓扑来自 `--server-shard-ips`/`--server-plan` 与 `--client-ips`/`--client-plan`，`--execution-backend` 取 `local` 或 `ssh`。
- `run_kvengine_compare.py`：默认 engines 为 `petkv dram_pet_dram dram_pet_tiered`，`--dram-allocator CONCURRENT_SLAB_MEMORY_POOL`；`--read-mode {exists,get,batch_get_flat}`、`--engines`、`--workloads`、`--threads`；`--draw` 只重绘 `summary.csv`。
- `benchmark_kv_engine` 的 tiering 旋钮分两组：`--tiering_cache_policy` / `--tiering_cache_budget_ratio` / `--tiering_promote_min_misses` 有 `--tiered_cache_*` 别名，同参数两种名字给了不同值会直接报错；CLOCK 另有 `--tiered_clock_{frequency_admission,cost_aware,async_exchange,exchange_queue_entries,exchange_queue_bytes}` 与 `--tiered_retain_backing_copies`、`--tiered_cache_expected_dram_bytes`。名单与在线准入走另一组：`--tiered_dram_keys_path`、`--tiered_online_admission`（同时把 `high_watermark_ratio` 提到 0.90）、`--tiered_async_admission`（要求前一个），装载侧可用 `--load_batch_keys` 改走 `BatchPut`。
- 访问序列可以完全脱离随机分布：`--distribution=trace --access_trace=<binary uint64>` 回放真实 key 流，`--warmup_access_trace` 单独给预热窗口，`--load_order` 按历史热度决定初始装载顺序。`--read_trace_path=<文本 query log>` 是同一位置的另一种输入（经 `ssd_layout::ReadQueryLog` 转成 pin 序列，记录数必须等于 `--record_count`），与 `--access_trace` 互斥。结果行新增 `process_peak_rss_kb`；正式计时前 `ResetStats()`，收尾 `DrainBackgroundWork()`，预热/计时窗口与 `YCSB_RUN_MAINTENANCE` 一起决定"异步交换是否已排空"。
- `build_tiered_dram_profile.py`：从历史稀疏窗口生成 `--tiered_dram_keys_path` 要的 `dram_keys.bin` + `profile.json`（`--strategy {frequency,density}`、`--key-encoding {contiguous,fused}`、`--profile-end`、`--dram-rows`），输出目录必须不存在；评估窗口不参与选择。
- `recstore.telemetry`：ctypes 加载 `libreport.so` 调 `report()`，让 Python 样本与 C++ 调用点进同一批 sink；导出 `available` / `emit` / `library_path` / `report_metric` / `reset`，库缺失时 `available()` 为 `False`、`emit()` 返回 `False` 而不抛，`RECSTORE_REPORT_LIBRARY` 覆盖库路径且候选按 mtime 取新。`rs_demo --report-metrics` 用它把 `_E2E_STEP_METRICS` 的 13 列以 `e2e_step` 表发出（仅 rank 0），连续循环的 loss 在末尾读回后补发。
- `run_tiered_cache_sweep.py`：按 `--policies {none,lru,clock,adaptive}`、`--cache-budget-ratios`、`--ssd-ratios`、`--record-count`、`--dram-slot-bytes`（必填）扫缓存预算与 SSD 比例，产物是 `summary.csv` + `summary.md`；`--disable-fit-check` 把 `expected_dram_bytes` 置 0，比较"已知工作集"与"未知工作集"两种策略选择。
- `e2e/custom/cli.py`：默认 `--transports brpc`、`--index-type DRAM_PET_HASH`；`runtime.py` 把 `--ps-kv-backend` 写死为 `recstore_dram`，所以这条 e2e 链路没有 tiering 段。tiered 的端到端数字走 `model_zoo/rs_demo` 自身入口（`--ps-kv-backend recstore_tiered --tiered-cache-policy {LRU,none,clock}`，默认 `clock`），`docs/performance/tiered-e2e.md` 的基线就是这条路径且显式标为 cache-off。
- `run_ps_dram_transport_benchmark.py`：临时起 PS 测本地 DRAM transport，同样写入 `tiering.cache_policy=none`。
- lane 驱动：`run_all.py` / `run_main_results.py` / `run_stage_breakdown.py` / `run_recstore_chain.py` 共用 `tools/benchmarks/lanes.py#build_suites`，lane 固定 `steps=12`、`warmup=2`（`common.py`）。
- 拓扑：本地用 `127.0.0.1` 起单 client / 单 shard；跨机用 `--client-plan`/`--server-plan` 指定 host，`--execution-backend ssh` 远程拉起。完整驱动与产物清单见章末基准附录。

### 代码位置

- `src/benchmark/ps/ps_transport_benchmark.cc#PrintTransactionResult` — `transport=/op=/phase=/summary ...` 行格式。
- `src/storage/kv_engine/benchmark_kv_engine.cc` — workload / read mode / latency / trace 输入 / 名单与在线准入开关。
- `tools/benchmarks/build_tiered_dram_profile.py#build_profile` — 历史窗口 → `dram_keys.bin` 与 `profile.json`，`src/test/scripts/test_build_tiered_dram_profile.py` 覆盖排序、density 估计、fused 编码与非法参数。
- `tools/benchmarks/perf_suite.py`、`#perf/cases.json`、`#perf/README.md` — 用例注册表与执行器。
- `tools/benchmarks/run_benchmark_ps.py#parse_args`、`#write_summary_markdown`；`#run_kvengine_compare.py#parse_args`、`#_cmd_draw` — 两个主驱动。
- `tools/benchmarks/lanes.py#build_suites`、`#runner.py#summarize_artifacts`、`#common.py` — lane 定义与产物汇总。
- `tools/benchmarks/e2e/custom/cli.py`、`#custom/runner.py`、`#custom/report.py#LATENCY_BREAKDOWN_COLUMNS` — 端到端驱动与报告列。

### 交付一句

第 4 块到此为止，读者应当能按"要回答什么"选层，并知道数字能不能进基线。第 5 块接验证路径，把改动落点映射到具体命令。

## 第 5 块：改动 → 验证路径

### 它是什么

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

### 它为什么存在

这个仓库的测试前置条件差异很大，随手跑全量会被硬件依赖卡住。按落点选最小集，是把"验证"从一次昂贵的仪式变成一次几秒钟的确认；只有改动跨层时，才需要往上加一档。

### 它和谁接

向上被开发者手工执行，向下调用第 3 块的测试与第 4 块的基准。它也是 CI 的定义来源，CI 只是把同样的命令按 lane 编排。

### 代码位置

- `.github/workflows/test.yml` — 三条 ctest lane 的 `-L`/`-LE` 与排除规则。
- `tools/ci/reproduce.sh` — 本地复现同一组 lane。
- `src/test/CMakeLists.txt` — 表里引用的测试目标名。

### 交付一句

第 5 块到此为止，读者应当能按落点直接挑命令。第 6 块接工程工具，补齐 CI 之外的日常入口。

## 第 6 块：工程工具与文档构建

### 它是什么

工具围绕"让同一套检查在本地和 CI 里跑出同样结果"展开。本章只保留四条与本篇内容直接相关的入口。

| 工具 | 入口 | 作用 |
| --- | --- | --- |
| 文档站 | `mkdocs.yml` + `docs/requirements.txt`，CI 执行 `mkdocs build --strict` | nav 覆盖 usage / dev / architecture / calc / parameter_server / storage / performance / api；`not_in_nav` 排除 `agent/perf.md`、`calc/interfaces.md`、`dev/performance.md`、`dev/zero_config_run.md` |
| 文档门禁 | `.github/workflows/doc-check.yml` | PR 触及 `README.md`、`docs/**`、`mkdocs.yml` 或部署 workflow 时跑同一套 `mkdocs build --strict`，坏链与失配的 nav 在合并前失败 |
| 格式 | `tools/format/clang_format.sh [--check] [--all\|--staged\|--changed]` + `.githooks/pre-commit` | 只处理 `src/**/*.{cc,cpp,h}`；CI 固定 `clang-format==18.1.3` |
| 注册守卫 | `src/test/scripts/check_test_registration.py`（ctest 项 `test_registration_consistency`） | 新增测试必须注册或写入 `EXEMPT`，见第 3 块 |

CI 复现（`tools/ci/reproduce.sh`）、覆盖率（`tools/coverage/`）、打包（`tools/packaging/`）、配置定位（`tools/config/`）、环境采集（`tools/env/collect.py`）仍在仓库里，本章不展开。

### 它为什么存在

CI 与本地环境的差异是排查成本的主要来源。复现脚本、容器化测试包装与环境采集共同压缩这个差异；格式与注册守卫则把"评审意见"前置成"提交前就失败"。

### 它和谁接

向上被开发者和 CI 直接调用，向下操作构建目录、测试驱动与文档站。它不改变被测代码，只改变"检查什么时候跑、跑完写到哪"。

### 代码位置

- `tools/format/clang_format.sh`、`.githooks/pre-commit`、`.github/workflows/format.yml` — 格式与钩子。
- `mkdocs.yml`、`.github/workflows/doc-deploy.yml`、`.github/workflows/doc-check.yml`、`docs/performance/methodology.md` — 文档站、PR 门禁与口径来源。
- `src/test/scripts/check_test_registration.py`、`.github/workflows/test.yml` — 注册守卫与 CI lane。

### 交付一句

第 6 块到此为止。6 块走完：接入 → 其它模型 → 测试 → 基准 → 验证路径 → 工具。下面的附录与风险清单按需查阅。

## 附：测试清单

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

## 附：基准清单

- **storage**：`benchmark_kv_engine`（YCSB workload、`--read-mode {exists,get,batch_get_flat}`、`--report-latency`、`--report-stages`、`--read_trace_path` / `--load_batch_keys`、`--tiered_dram_keys_path` / `--tiered_online_admission` / `--tiered_async_admission`）；`run_kvengine_compare.py`（`--engines` 默认 `petkv dram_pet_dram dram_pet_tiered`，可选 `fasterkv`、`fasterkv_ssd`、`hps_rocksdb`；`--workloads`、`--distributions`、`--batch-keys`、`--record-count`、`--runtime-seconds`、`--threads`）；`build_tiered_dram_profile.py`（名单生成）；`run_storage_backend_compare.py`、`run_hps_backend_compare.py`、`run_hps_tiered_ratio_compare.py`、`run_ssd_layout_microbench.py`；`tools/benchmarks/batch_test/`（SSD 密集扫描旁支，自带 README）。
- **ps_transport**：`ps_transport_benchmark`、`rdma_rc_transport_benchmark`、`recstore_mixed_benchmark`、`benchmark_client`、`backend_benchmark`（`src/benchmark/CMakeLists.txt`）；`run_benchmark_ps.py`（local/ssh、RDMA 专项开关、缺省输出 `results/benchmark_ps_<MMDDHHMM>`）、`run_ps_dram_transport_benchmark.py`、`run_rdma_rc_transport_benchmark.py`、`run_rdma_transport_benchmarks.py`；`run_local_shm_mixed_benchmark.py`、`run_hierkv_recstore_mixed_benchmark.py`。
- **e2e**：`e2e/custom/cli.py` + `runtime.py` + `runner.py` + `report.py`（`criteo_kaggle/bench_compare.py` 是它的封装）；`e2e/run_two_node_rdma_compare.sh`（默认 local `10.0.2.192/GPU3`、remote `10.0.2.191/GPU0`、PS 端口 15000、输出 `results/e2e_<MMDDHHMM>`，开跑前先跑 `petps_*` 相关 ctest）；lane 入口 `run_all.py`、`run_main_results.py`、`run_stage_breakdown.py`、`run_recstore_chain.py`，产物汇总 `summary/raw_metrics.{json,csv}` 与 `aggregated_metrics.csv`。
- **perf**：`perf_suite.py`（`run` / `ab` / `aggregate` / `env`）、`perf/cases.json`、`perf/baselines/<env-id>/`、`perf/README.md`、`perf/test_perf_suite.py`。


## 与相邻章节的接口

| 章节 | 本章向上依赖 | 本章向下提供 |
| --- | --- | --- |
| 01 总览与构建 | 构建产物名（`ps_server`、`petps_server`、`recstore_torch_ops`、`benchmark_kv_engine`）、CMake 选项 | 各产物的验证入口与基准入口 |
| 02 计算层 / PyTorch | `RecStoreClient`、`RecStoreEmbeddingBagCollection`、`SparseSGD`、`PSPipeline`、`BagPipe` | 接入示例（rs_demo / torchrec_dlrm）、精度对齐与 topk 验证网 |
| 03 参数服务器与传输 | `ps_transport_benchmark` 的 `transport=` 口径、`summary` 行格式 | PS 基准命令、拓扑参数、`summary.md` 格式 |
| 04 RDMA | `RECSTORE_RDMA_*` 环境变量、`rdma_integration` 测试标签 | RDMA 验证阶梯（协议 → 集成 → 基准）与跳过语义（exit 77） |
| 05 存储与内存 | KVEngine 组合、`--index-type`/`--value-store-type`/allocator 名称 | `run_kvengine_compare.py` 的 engine 组合与 YCSB 口径 |

## 风险、坑与未确认点

### 近期已修复（5f92ba2a → 6d205e98）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| `torchrec_dlrm` 顶层 import 指向不存在的 `python.pytorch.torchrec` | 改指 `python.pytorch.torchrec_kv.EmbeddingBag`，`test_torchrec_dlrm_imports_py` 守护 | `4d134e6b` |
| `test_cceh.cpp` 未编译 | `CCEH.cpp` 编进目标并注册，`storage;slow`、600 s、`RUN_SERIAL` | `942468d9` |
| `test_ssd_extendible_hash.cpp` 引用已删 API | 文件已删除 | `942468d9` |
| 测试文件可能静默漏注册 | 注册守卫 + `test_registration_consistency`，新增测试不注册即 CI 失败 | `942468d9` |
| torchrec 依赖测试分散且 CI 无 torchrec | 五模块合并为 `test_recstore_torchrec_py`，按 `import torchrec` 条件注册 | `e96b91cd` |
| `max_batch_keys_size` 散落在配置与驱动里 | 配置/驱动已删；`CachePS` 检测到仍打 WARNING 并忽略 | `5530c44a` |
| 没有可回归的性能门禁 | `perf_suite.py` + `cases.json` + 双标签 + 按机器基线 | `aea93f8b` |

### 本轮已修复（6d205e98 → 7c44f83da）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| tiered 拓扑没有 cache-on / cache-off 开关，读缓存配置只能手写 | `rs_demo --tiered-cache-policy {LRU,none}` 与 `benchmark/server.py` 的 `tiered_cache_policy` 一起把策略写进 `value.tiering.cache_policy`，非法值在参数校验阶段拒绝 | `e7ca11c5` |
| 没有多策略、多预算的 tiering 扫描脚本 | `tools/benchmarks/run_tiered_cache_sweep.py` 扫 policies × budget × SSD 比例，可关掉工作集检查；产物 `summary.csv` + `summary.md` | `a8c8de32`、`df0edc94` |
| tiered 的端到端数字没有可引用基线 | 新增 `docs/performance/tiered-e2e.md`（双机 RDMA、SSD 比例扫描），并显式标注 cache-off 口径 | `73ab4e2a`、`fd598b41` |
| 文档坏链只在部署时暴露 | 新增 `doc-check` workflow，PR 触及文档即 `mkdocs build --strict` | `4ccead0c` |
| `test_report` 只在 Debug 构建注册 | `USE_PERF_REPORT=ON` 即可编译并注册，覆盖 sink 选择与配置缓存失效 | `0d4247de` |

### 本轮已修复（7c44f83da → f8fde5af4）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| 基准只能回放二进制 key trace，无法直接用文本 query log，也没有名单生成工具 | `--read_trace_path`、`build_tiered_dram_profile.py` + `test_build_tiered_dram_profile_py` | `cb296098` |
| 基准里看不到在线准入与后台交换的开关，也没有进程峰值内存 | 新增 `--tiered_{dram_keys_path,online_admission,async_admission}`、`--load_batch_keys`，结果行带 `process_peak_rss_kb`，计时前 `ResetStats()`、收尾 `DrainBackgroundWork()` | `cb296098` |
| SSD 写侧没有计数，写放大只能靠推断 | 页写与 payload 字节进了 `ExtraResultFields()`，`test_ssd_allocators` / `test_ssd_static_layout_value_store` 直接断言页写数 | `8edd10be`、`2c107b30` |

### 本轮已修复（f8fde5af4 → 1f340167d）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| tiered 策略只能 `LRU` / `none` 二选一，e2e 默认值还把 cache-off 基线带偏 | `--tiered-cache-policy` 接受 `LRU` / `none` / `clock`，`rs_demo` 默认 `clock`、`benchmark/server.py` 模板默认 `none`；上游文档补了策略判据 | `571c6d51`、`170ddb17` |
| Python 侧没有上报入口，`KVClient` 自己写死 `build/lib/libreport.so` | `recstore.telemetry` 经 ctypes 复用 C++ reporter（缺库时静默返回 `False`），`rs_demo --report-metrics` 发 `e2e_step` 表；CSV / JSONL sink 跨进程行原子 | `9691f88d`、`0133f3ba`、`db92eb1a` |

### 仍存在

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

## 证据索引

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

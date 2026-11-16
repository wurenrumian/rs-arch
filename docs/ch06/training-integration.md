---
title: 第 1 块：训练接入
description: 自带后端的演示训练工程：起停参数服务器、跑完整 DLRM 循环、把阶段耗时写成 CSV。
outline: [2, 3]
---

## 它是什么

仓库里有一个自带后端的演示训练工程，它同时承担三件事：起停参数服务器、跑一个完整的 DLRM 训练循环、把每个阶段的耗时写成 CSV。它是"怎么接"的参考实现，也是端到端基准的被执行程序。

## 它为什么存在

接入 RecStore 要处理的是一串有顺序的请求：查询要在前向之前发出，梯度要在反向之后提交，提交之后还要有一个显式等待，检查点必须在所有提交落地之后才能拍。演示工程把这些顺序固化成一条可跑的循环，新模型照抄这条顺序即可，不必重新推导。

## 它和谁接

向上被 CLI 与基准驱动脚本调用，向下通过 Python 绑定落到 PS，再由 PS 落到存储。它自己不实现存储语义，只决定"什么时候发什么请求"。

### 子块 1.1：启动链

一次后端运行的分层顺序（`model_zoo/rs_demo/cli.py#main`）：

1. `parse_config` 解析 CLI 或 `--run-config-json`，`populate_default_paths` 填默认输出路径；
2. `validate_recstore_config` / `validate_torchrec_config` / `validate_hps_torch_config` 做交叉约束校验（例如 `read_mode=ps_pipeline` 必须 `plugin=none`、无 GPU cache、无 prescan、且开启 embedding fusion）；
3. `make_runtime_dir` 生成 `recstore_config.json`（含 `ps_type`、KV 容量、`value_size_bytes = embedding_dim * 4`、index 类型；`ps_kv_backend=recstore_tiered` 时还写 DRAM 容量倍率与 `value.tiering.cache_policy`），并把路径写进 `RECSTORE_CONFIG`；`--tiered-cache-policy` 接受 `LRU` / `none` / `clock`，默认 `clock`（主放置交换），只有 `none` 才是 cache-off 基线；
4. 需要时 `start_server`（RPC/SHM）或 `start_rdma_server_cluster`（RDMA，额外注入 `RECSTORE_RDMA_*` 环境变量）；
5. `build_runner(...).run(...)`：单进程直接进 `_run_local_worker`，多进程走 `BenchmarkRunner._run_distributed`，用 `torch.distributed.run` 重新拉起 `run_mock_stress.py`，每个 rank 读同一份 `worker_config.json`；
6. rank 把行写入 `rank<N>.csv`，主进程 `_merge_rank_csvs` 合成 `recstore_main.csv`，随后 `cli.py` 调 `analyze_embupdate` 生成 `recstore_embupdate.csv`。

### 子块 1.2：读路径选择

建读路径的那一步决定"查询怎么发、梯度怎么回"，四种模式各有硬约束。

| `--read-mode` | 实现 | 关键约束 |
| --- | --- | --- |
| `direct` | `DirectReadPath` | 同步查询；`prefetch_depth` 被忽略（runner 会打印提示） |
| `prefetch` | `PrefetchReadPath` | 深度由 `--prefetch-depth` 控制 |
| `bagpipe` | `BagPipeReadPath` + `OptimizationPluginRegistry.create("bagpipe")` | 自动把 `optimization.plugin` 设为 `bagpipe`；`prescan` 需显式开启 |
| `ps_pipeline` | `PSPipeline` 或 `GPUOwnerPipeline` | 必须 fusion、`plugin=none`、无 GPU cache、无 prescan；GPU owner 还需 RDMA + `--dense-cuda-graph` |

`ps_pipeline` 的早期提交由 `PSPipelineSGD.submit_pooled_grad` 挂到 `embedded_sparse` 的 autograd hook 上（`--ps-pipeline-early-submit`），否则在 step 内用 `record_pooled_grad(sparse_grad)` 显式记录。

### 子块 1.3：一个 step 的接入点

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

### 子块 1.4：checkpoint 的真实入口

真正可恢复的快照在 PS 侧，不在 runner 里：

- `KVClient.save_checkpoint(path, metadata)` 先 `flush_async_updates()`，再把 metadata 当 JSON 校验（必须含 `identity` 与 `checkpoint_id`），最后调用 ops 的 `save_checkpoint`。
- `KVClient.load_checkpoint` 拒绝存在 pending async op 的客户端，成功后清 GPU cache。
- 训练侧诊断快照是 `runtime/validation.py#export_validation_state`（`--validation-state`），文件里显式标注"diagnostic snapshot, not a resumable training checkpoint"。

> 文档与代码不一致：`recstore_runner.py#_run_local_worker` 的 `--save-checkpoint` 分支执行 `from ..checkpoint import export_checkpoint`，但 `model_zoo/rs_demo/` 下仍不存在 `checkpoint.py`；`--checkpoint-all-ranks` 只在 `config.py` 定义，没有消费者。该 CLI 路径当前不可用，checkpoint 只能走 `KVClient.save_checkpoint`。

## 代码位置

- `model_zoo/rs_demo/cli.py#main`、`#build_runner`、`#make_runtime_dir` — 启动顺序、`RECSTORE_CONFIG` 注入、RDMA 集群起停。
- `model_zoo/rs_demo/runners/base.py#BenchmarkRunner._run_distributed`、`#_merge_rank_csvs` — torchrun 骨架与 rank CSV 合并。
- `model_zoo/rs_demo/runners/recstore_runner.py#RecStoreRunner._build_read_path`、`#_run_local_worker` — 读路径分支与 step 循环。
- `src/python/pytorch/recstore/optimizer.py#SparseSGD.step`、`#flush` — 提交与刷新。
- `src/python/pytorch/recstore/KVClient.py#RecStoreClient.save_checkpoint`、`#load_checkpoint` — 检查点契约。

## 交付一句

第 1 块到此为止，读者应当能照抄这条循环把新模型接上，并知道检查点只能走客户端那条路。[第 2 块](./model-examples)接其它模型与例子，清点哪些脚本真的在用这套东西。

---
title: 第 7 块：配置与开关
description: 计算层配置分四层：构造参数、环境变量、构建宏、配置文件里真正被读的字段。
outline: [2, 3]
---

## 它是什么

计算层的配置分四层：模型与优化器的构造参数、环境变量、构建宏、配置文件里真正被读的字段。生效时机不同：宏在编译期定死，参数在对象构造时定，环境变量在进程启动或首次调用时读，配置文件在 op 首次使用时解析。

## 它为什么存在

计算层不理解"服务器怎么配"，它只关心三件事：走哪个后端、分片怎么路由、缓存与流水的参数是多少。把这三件事和传输层配置混在一张表里，会让人误以为改一个字段就能换传输。

## 它和谁接

上游是[第 01 章](../ch01/)的配置解析顺序（服务端与客户端各一套），下游是[第 3 块](./read-path)、[第 4 块](./write-path)、[第 5 块](./bagpipe)、[第 6 块](./pipeline)里读参数的地方。

## 代码位置

Python 参数（模型/优化层）：

| 位置 | 参数 | 作用 |
| --- | --- | --- |
| `RecStoreEmbeddingBagCollection.__init__` | `enable_fusion=True`、`fusion_k=30`、`fast_path_mode="auto"`、`fused_backend_table`、`backend_table_id`、`initialize_tables` | 融合键空间、local_shm 快路径、单表后端命名空间 |
| `RecStoreEmbeddingCollection.__init__` | `enable_fusion`、`fusion_k`、`clamp_ids`、`initialize_values`、`init_func` | 多表必须融合；clamp 越界 id |
| `SparseSGD.__init__` | `lr`、`keep_ratio` | Top-K 行压缩比例 |
| `SparseAdamW` / `SparseRowWiseAdagrad` | `lr`、`betas`、`eps`、`weight_decay` | 只校验 `RECSTORE_CONFIG` 里的服务端优化器配置与 Python 参数一致，不在客户端做数学 |
| `BagPipePlugin.create` | `lookahead`、`cleanup_proportion`、`cache_capacity`、`embedding_dim`、`fuse_k`、`table_offsets`、`table_sizes`、`prescan`、`aggregation`、`lr` | planned runtime 的全部策略参数 |
| `build_embedding_read_path` | `read_mode`、`prefetch_depth`、`feature_offsets` | `direct` / `prefetch` / `bagpipe` |
| `PSPipeline` / `GPUOwnerPipeline` | `dependency_split`、`total_steps`、`validation_state` / `owner_table_end`、`owner_table_types`、`metadata_lookahead` | 单步流水线与 owner 实验路径 |

环境变量：

| 变量 | 读取位置 | 效果 |
| --- | --- | --- |
| `RECSTORE_CONFIG` | `op_runtime_support.cc#GetGlobalConfig`、`optimizer.py#_server_sparse_optimizer_config` | 指定 `recstore_config.json`；C++ 找不到就抛错，Python 优化器读同一文件校验 lr/eps |
| `RECSTORE_DEFER_OPS_LOAD` / `RECSTORE_DEBUG` | `recstore/__init__.py` | 前者为 1 时不在 import 时加载原生扩展（测试用），后者打印扩展加载路径 |
| `RECSTORE_VALIDATE_GPU_CACHE_KEYS` | `KVClient.py#_reject_gpu_cache_reserved_ids` | 对 CUDA ids 也做保留 key 检查 |
| `RECSTORE_OUTPUT_CACHE` | `sharded_client.py` | 设为 0 关闭 `(rows, dim)` 输出缓冲复用 |
| `RECSTORE_BAGPIPE_DENSE_SHARED_MAX_ROWS` | `bagpipe_cache/controller.py` | shared 集合超过该行数时把 shared id 折进 sparse all_gather（默认 4096） |
| `RECSTORE_PS_DEVICE_MERGE` / `RECSTORE_PS_OWNER_GPU` | `ps_pipeline/pipeline.py`、`owner.py#owner_options_from_env` | 前者在 GPU 上合并 clean/dirty 行，后者启用 world-2 GPU owner 路径 |
| `RECSTORE_SPARSE_COMMIT_PROFILE` | `ps/base/sparse_gradient_commit.h` | 打印 `component=sparse_commit event=runtime_phase` 阶段耗时 |

构建宏：`RECSTORE_ENABLE_GPU_CACHE` 编译 `gpu_cache_adapter.cu` 与 cache bindings（未定义时 `enable_gpu_cache` 返回 false，查询类 op 直接 `TORCH_CHECK(false)`）；`USE_FAKE_KVCLIENT` 用 `common/op_mock.cc` 替换整份 `op.cc`，提供内存 KV；`ENABLE_PERF_REPORT` 打开 `op_latency` / `embread_stages` / `embupdate_stages` 上报与 flame graph。

配置文件里计算层真正读取的字段：

| 字段 | 默认 | 计算层效果 |
| --- | --- | --- |
| `cache_ps.ps_type` | `"GRPC"` | `ResolveFrameworkPSClientType` 决定构造哪个 `BasePSClient`；额外接受 `RDMA`、`LOCAL_SHM`、`hierkv` |
| `cache_ps.optimizer.{type,learning_rate,epsilon,beta1,beta2,weight_decay}` | SGD / 0.01 / 1e-10 | Python 优化器构造时校验；服务端真正执行 |
| `distributed_client.{servers,num_shards,hash_method,max_keys_per_request}` | 无 / 无 / `city_hash` / 500 | 分片客户端路由；`max_keys_per_request` 影响单次 RPC 行数 |
| `client.{host,port,shard}` | `127.0.0.1:15000` | `set_ps_config` 重建单点客户端 |
| `local_shm.{region_name,slot_count,slot_buffer_bytes,client_timeout_ms}` | `recstore_local_ps` / 64 / 8 MiB / 30000 | slot 池大小决定 batch 上限与 `local_update_flat` 的单次行数 |

**关于 `RecStoreConfig` / `client_options`**：代码里没有名为 `RecStoreConfig` 的 Python 类，也没有 `client_options` 对象；等价的 Python 配置是 `model_zoo/rs_demo/config.py#RunConfig`，等价的 C++ 配置是 `src/ps/client_options.h#PSClientCreateOptions`。

## 交付一句

七个部件闭合。后面三节是边界、风险和证据。

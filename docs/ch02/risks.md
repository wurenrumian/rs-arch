---
title: 风险、坑与未确认点
description: 近期与本轮已修复的问题清单，以及 18 条风险、坑与未确认点。
outline: [2, 3]
---

## 近期已修复（5f92ba2a → 6d205e98）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| 同一表混用两种更新模式，lr 静默施加两次或零次 | `_record_table_update_mode` 按 `(client, table)` 记录首次模式，冲突抛 `RuntimeError` | `f8dc8545` |
| 普通 `EmbeddingCollection` 适配器缺少融合属性时快路径探测报 `AttributeError` | `_uses_shared_local_shm_single_table` / `SparseSGD` 改用 `getattr` 默认值，只是不进快路径 | `281edb1a` |
| `torchrec_dlrm` 顶层 import 死路径 | 改为 `python.pytorch.torchrec_kv.EmbeddingBag`，`test_torchrec_dlrm_imports.py` 守护 | `4d134e6b` |
| `docs/architecture/bagpipe_cache.md` 把 planned 与 TTL 机制混写 | 重写为 planned 的"启用 / 每步流程 / 容量"，与代码一致 | `71081450`、`e5de2c22` |

## 本轮已修复（6d205e98 → 7c44f83da）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| 客户端学习率在传输路径上丢失，服务端只能用自己的 lr | `update_async` / `local_update_flat` / `emb_update_table` / `EmbUpdateCached` 增加 `learning_rate` 参数并透传到 PS，`0` 表示不上报；`hierkv` 本地运行时也接受显式 lr，缺省仍用 0.01 | `606d86f5` |
| 分片客户端与服务端 lr 不一致时静默按服务端值更新 | 服务端 `CheckLearningRate` 拒绝整批更新，客户端收到失败；`test_sharded_update_async_lr.py` 覆盖透传 | `8a63bfed` |

1. **两套 BagPipe controller 同名导出会误导。** `bagpipe_cache/__init__.py` 导出 `planned.BagPipeCacheController`，`plugin.py` 也用它；`controller.py` 的 TTL 版本只有单测导入（`rg "from .controller"` 在非测试代码里只命中 `optimizer.py` 的 `TYPE_CHECKING` 分支）。读错文件会得出完全不同的"谁拥有参数"的结论。
2. **生产 BagPipe 不启用 C++ GPU cache。** runner 只把 `cache_capacity` 传给 planned controller，没有调用 `client.enable_gpu_cache(...)`；因此 `gpu_cache_lookup_flat*` / `invalidate_gpu_cache*` / generation 校验在生产 `read_mode=bagpipe` 下都不会被触碰。
3. **`EmbRead` 对不存在的 key 静默返回 0。** `KVClientOp::EmbRead` 在调后端前 `std::fill_n(values_data, total, 0.0f)`；`validate_keys` 只查 dtype 与维度，不校验 key 是否已初始化、也不校验 id 是否 `< num_embeddings`。越界 id 不报错，只得到 0 行。保留哨兵 key 的检查只在 GPU cache 相关路径触发，普通 `pull` 不经过它。
4. **`CommonOp` 的异步写/删除/存在性接口是死接口。** `EmbDelete`、`EmbExists`、`EmbWriteAsync`、`IsWriteDone`、`WaitForWrite`、`SaveToFile`、`LoadFromFile` 在 `op.cc` 里全部 `throw std::runtime_error("Not impl")`；`EmbInit(keys, InitStrategy)` 只校验 key，不写值。`KVClient.init_data` 的默认初始化是 Python 侧 `torch.zeros` + `emb_write`。
5. **`DistTensor.__del__` 的清理是半成品。** `delete_data` 先 `del` 本地元数据，再抛 `NotImplementedError`，`__del__` 捕获并打印 warning；结果是后端数据残留、Python 元数据已丢，重复创建同名 tensor 会走"已存在"分支并读不到正确元数据。
6. **`ShardedRecstoreClient` 的路由开销与连接重建。** `_group_indices` 对每个 key 调 `int(key)` 并 `keys.tolist()`，是 O(N) 主机循环 + 同步；非 native 后端每次切分片都 `set_ps_config` 重建 `BasePSClient`。它没有接入生产 runner，不要当作多分片训练的默认路径。
7. **Top-K 的能力限制是硬编码的。** `keep_ratio < 1` 要求 `_enable_fusion`，后端必须 `grpc` / `distributed_grpc`（或同机 local_shm 快路径）；`DistEmbedding` 与非融合 `EmbeddingCollection` 直接拒绝。`_validate_topk_module` 在第一次 `step()` 前做 fail-closed 校验，配置错误只在运行时暴露。
8. **BagPipe planned 的 prescan 对齐只校验 unique 数。** `enqueue` 用 `_prescan_batch_numels[batch_num % len]` 比较 `unique_ids.numel()`；两个 batch 若 unique 数相同但 ID 不同，tripwire 不会触发，后续按 prescan 尺寸分片的 all_gather 仍可能错位。代码注释声称"任何重排都会改变某个 batch 的 unique 数"，这并不严格成立。
9. **best-effort GPU cache SGD 会静默丢更新。** `ApplySgdUpdateBestEffortGpuCache` 只更新 resident 行，缺失行跳过、不报错、不同步；TTL controller 依赖 `_cached_dev` 镜像与 `prefill_no_evict` 的权威 mask 保证一致，但 `_prefill_gpu_cache_from_fused_prefetch` 在预取结果尺寸不匹配时会 warning 后 fallback，镜像与实际 cache 可能短暂分叉。
10. **GPU cache profile 已失效。** `cache_profile.h` 注明 collection 已被 external-release cleanup 移除，`GetLastGpuCacheProfile()` 返回全 0；`ShardedRecstoreClient.get_last_gpu_cache_profile()` 仍输出 8 个 0 字段。基准报告若依赖这些字段，会把"没有采集"误读成"没有 miss"。
11. **`RecStoreClient` 是单例，第二次构造会忽略 `role`。** `__new__` 只创建一次，`__init__` 用 `_initialized` 直接返回；`RecStoreClient(role="train")` 之后再 `RecStoreClient(role="eval")` 仍是同一对象、旧 role。测试里必须手动 `RecStoreClient._instance = None`。
12. **`EmbUpdateAsync` 只支持 RDMA。** `op.cc#KVClientOp::EmbUpdateAsync` 在 `ps_backend_name_ != "rdma"` 时抛错；`KVClient.update_async` 的 staged 分支只是延迟到 `wait()` 才同步提交，若调用方从不 `wait` / `flush`，内存按 clone 的 ids/grads 增长。`save_checkpoint` 会先 `flush_async_updates()`，普通训练循环不会自动清。
13. **owner v4 的硬约束没有回退。** 见[第 6 块](./pipeline)；`sparse_owner_replace_close` 的 abort 是 sticky failed。
14. **`recstore.cc` 是空文件。** `src/framework/common/recstore.cc` 只有 `namespace recstore {}`；按文件名找"框架主入口"会找错，真正入口是 `op.cc` / `op_torch.cc`。
15. **文档与代码不一致（`docs/api/python.md`）。** 该文写 `prefetch` / `wait_and_get` "也可用 `wait(handle)` 只等待完成"；但 `KVClient.wait(handle)` 只查 `_pending_async_ops`（update 句柄），未知 handle 直接 `RuntimeError`。prefetch 没有"只等待"的 Python API，只有 `emb_wait_result`（必须给 `embedding_dim`）。
16. **文档与代码不一致（`docs/dev/feature/add_operator.md`）。** 该文写 `KVClient.__init__` 调 `torch.ops.load_library("lib_recstore_ops.so")`、`EmbUpdate` 调 `UpdateParameter(table_name, keys_array, &grads_vector)`；实际加载在 `recstore/__init__.py#_ensure_native_loaded`（`torch.classes.load_library` + 多路径发现），`EmbUpdate` 的 C++ 签名是 `UpdateParameter(table_name, ConstArray<uint64_t>, const RecTensor&)`。该文的 `op_torch.cc` 示例也早于当前"按 op family 拆分注册"的结构。
17. **文档示例与 runner 的参数入口不完全一致。** `docs/architecture/bagpipe_cache.md` 的示例写 `--ps-type RDMA --read-mode bagpipe ...`，参数在 `model_zoo/rs_demo/config.py` 里都存在，但没有提到 `read_mode=bagpipe` 会自动把 `optimization.plugin` 设为 `bagpipe` 并把 `lookahead` 默认成 `prefetch_depth or 4`。
18. **未确认**：`RecStoreConfig` / `client_options` 在任务描述中被当作既有配置对象；全仓库无 Python 命中，只有 `src/ps/client_options.h#PSClientCreateOptions`。

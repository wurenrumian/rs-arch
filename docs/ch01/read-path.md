---
title: 第 3 块：读路径
description: 一次前向查表从 Python 张量走到存储行，分支选择都在 Python 侧。
outline: [2, 3]
---

## 它是什么

一次前向查表，从 Python 侧的张量开始，到"存储层刚刚被读了一行"结束。中间有两处关键分叉：一处决定走哪条读策略，一处决定发给哪个分片。所有分支选择都在 Python 侧做，C++ 只提供原语——这个事实决定了你调试时该在哪一层加日志。本块按发起、分流、扇出、回收四个阶段走。

## 它为什么存在

[推断] 读是训练循环里最频繁的操作，读路径围绕三件事设计：不要把 key 逐条发出去、不要把结果逐条拷回来、不要在没命中缓存时把主线程卡死。理解这些成本，才知道为什么某些"看起来该在 C++ 里"的逻辑其实在 Python。

## 它和谁接

上游是第 2 块的 `torch.ops.recstore_ops` 入口，下游是第 05 章的 `BaseKV::BatchGet`。本章只讲到"进入存储层"为止。

## 代码位置

**阶段一：发起。** 模型从 `DistTensor.__getitem__` 或 embedding 模块的 `forward` 出发，调用 `RecStoreClient.pull(name, ids)`。客户端先 `_normalize_ids`（转 `int64`、`contiguous()`、非 `preserve_device` 时搬到 CPU），再由 `_encode_ids` 把表 tag 或进 key 高位（`tag << 56`）。`RecStoreClient` 是单例（`__new__` + `_initialized`），构造时绑定 `self.ops = torch.ops.recstore_ops`。`emb_read` 由 `RegisterBaseOps` 绑定到 `emb_read_torch`，后者转给 `CachedReadTorch(keys, dim)`，并在这一层做 dtype/shape 校验。

**阶段二：分流。** `CachedReadTorch` 分配输出缓冲（CUDA 场景用 pinned CPU 缓冲），调 `g_cache_aware_op.Lookup(rows, io, no_evict)`。GPU cache 可用（编译开关打开且 `CanUseGpuCache(keys, dim)`）时走 query → read_missing → fill → scatter；否则走 `io.read_all`。低命中率连续出现会触发 bypass 并清空 cache。`read_all` 里，key 在 CUDA 上时先 `StageCudaTensorToPinnedCpu`，随后 `ToRecTensor` 生成借用视图，再调 `op->EmbRead(k, v)`。

`op` 是 `GetKVClientOp()` 用 `std::call_once` 造的进程内唯一 `KVClientOp`；`GetConcreteKVClientOp()` 再做 `dynamic_pointer_cast` 并断言后端确实是 `KVClientOp`。`EmbRead` 先处理 `hierkv` 短路，再校验 dtype/维度/行数，把输出清零，最后 `ps_client_->GetParameter(keys_array, values)`。

**阶段三：扇出。** 多态分派到 `DistributedShardedClient<ClientT>::GetParameter`：`PartitionKeys` 用 `GetShardId(key) = GetHash(key) % num_shards`（`simple_mod` 时 `key % num_shards`），为每个 shard 分配结果缓冲，按 `max_keys_per_request`（默认 500）分块，用 `std::async` 并发发出。单分片客户端在本进程的 async 线程里发起 RPC，这就是进程边界。gRPC 侧另有 `FLAGS_get_parameter_threads`（默认 4）个 stub 与 `MAX_PARAMETER_BATCH = 2000`。

**阶段四：服务端与回收。** `ps_server` 由工厂键选出 `GRPCParameterServer` / `BRPCParameterServer`，其 `ParameterServiceImpl::GetParameter` 调 `CachePS::GetParameterRun2Completion(keys, packs, 0)`；`CachePS` 走 `base_kv_->BatchGet`，每行包成 `ParameterPack`，用 `ParameterCompressor` 压成 flat block 放进 `reply->parameter_value()`。回到客户端后按 `key_index_mapping_` 用 `ScatterEmbeddingRows` 写回调用方缓冲的原始行位置，CUDA 时再 `values.to(device, non_blocking=true)`。

失败语义：gRPC 客户端检查传输完成与每条 RPC 的 `Status`，失败向上返回错误，不再把清零缓冲当成功交回（细节与 deadline、prefetch 归第 03 章）。形态与所有权不变：`ids` 上层 `[N] int64`、C++ 视图 `[N] uint64`；`values` 为 `[N, D] float32`；CPU 缓冲由 PyTorch 分配器持有，跨层只传借用指针。服务端 `ParameterPack` 指向 `BatchGet` 返回的行内存或该线程的 thread-local 读缓冲，只在本次请求内有效。

按阶段对照代码：

| 阶段 | 步骤 | 代码位置 |
| --- | --- | --- |
| 发起 | 表句柄取行、单例客户端、id 归一化与 tag 编码 | `src/python/pytorch/recstore/DistTensor.py#DistTensor.__getitem__`、`KVClient.py#RecStoreClient.__new__`、`#_normalize_ids`、`#_encode_ids` |
| 发起 | op 注册与绑定、dtype/shape 校验、pinned 缓冲 | `src/framework/pytorch/op_torch.cc#TORCH_LIBRARY(recstore_ops, m)`、`op_base.cc#emb_read_torch`、`cache/tensor_adapter.cc#CachedReadTorch`、`#CheckKeys` |
| 分流 | cache-aware 查表与 bypass | `src/framework/cache/cache_aware_op.h#CacheAwareOp::Lookup` |
| 分流 | CUDA→pinned staging、借用视图 | `src/framework/pytorch/op_internal.h#StageCudaTensorToPinnedCpu`、`#ToRecTensor` |
| 分流 | 单例获取、后端下转型、`EmbRead` 清零与转发 | `src/framework/op.cc#GetKVClientOp`、`#GetConcreteKVClientOp`、`#KVClientOp::EmbRead` |
| 扇出 | 分片路由与分块 | `src/ps/base/dist_sharded_client.h#GetShardId`、`#PartitionKeys`、`#GetParameter` |
| 扇出 | 单分片 RPC 发起 | `src/ps/grpc/grpc_ps_client.cpp#GRPCParameterClient::GetParameter`、`src/ps/brpc/brpc_ps_client.cpp#BRPCParameterClient::GetParameter` |
| 服务端 | 服务实现与缓存编排 | `src/ps/grpc/grpc_ps_server.cpp#ParameterServiceImpl::GetParameter`、`src/ps/base/cache_ps_impl.h#CachePS::GetParameterRun2Completion` |
| 回收 | 行位置回填与回设备 | `src/ps/base/dist_sharded_client.h#ScatterEmbeddingRows`、`src/framework/pytorch/cache/tensor_adapter.cc#CachedReadTorch` |

## 交付一句

第 3 块到此为止：读路径在"进入存储层"这一步收尾。下一块接写路径，形状与读对称，但多一个麻烦——写有两种语义。

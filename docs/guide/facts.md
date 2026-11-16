---
title: 十条核心事实
description: 六章共同核对过的十条结论，先记住这些，再看各章细节。
outline: [2]
---

# 十条核心事实

这十条是六章交叉核对后剩下的骨架。每条都指向展开它的那一块；细节与例外在正文里。

## 1. 只有一次跨进程

`RecStoreClient` / `KVClient` → `torch.ops.recstore_ops` → `KVClientOp`（进程内单例）→
`CreatePSClient`（`PSClientType`：`kGrpc` / `kBrpc` / `kRdma` / `kLocalShm`）→ `ShardClient`，
越过进程边界到服务端 `CachePS`，再进入 `BaseKV` / `KVEngineComposite`。
计算层内部、服务进程内部都是同进程调用，只是类型上过了抽象。

→ [第 01 章的三层调用链](/ch01/call-chain)、[第 03 章的客户端栈](/ch03/client-stack)

## 2. 默认存储组合是全 DRAM

`DRAM_PET_HASH` 索引 + `DRAM_VALUE_STORE` 值存储 + `CONCURRENT_SLAB_MEMORY_POOL` 分配器。
SSD / NVM / tiered 都是可选路径，不是默认。

→ [第 05 章的组合矩阵](/ch05/composite-matrix)

## 3. key 空间是 `(id, tag)`

逻辑 key 由 `(id, tag)` 组成，`tag` 拼在 key 的高 8 位，让多张表共用一个 key 空间。
分片是 `hash(key) % num_shards`，每个分片由独立服务进程里的一个 `CachePS` 独占。

→ [第 03 章的分片与路由](/ch03/sharding)

## 4. 学习率现在跨进程可见

`update_async` / `local_update_flat` / `emb_update_table` 把客户端 `lr` 随请求送到 PS：
proto 的 `learning_rate`、local_shm 槽位头、RDMA descriptor 各有一份副本。
`CachePS::CheckLearningRate` 与优化器不一致时拒绝整批更新。
`DistEmbedding` 仍是客户端 pull-modify-push；同一 `(client, table)` 换模式由 `_record_table_update_mode` 直接抛错。

→ [第 01 章的两种更新语义](/ch01/write-path)、[第 02 章的梯度提交](/ch02/write-path)

## 5. 四类传输，`auto` 不在二进制里

gRPC、bRPC、RDMA、local_shm 四条路径。RDMA 的 GET 有 `direct_sg` 与 `staging_copy` 两种响应模式；
`auto` 只存在于工具层（`run_benchmark_ps.py`、`rs_demo/cli.py`），二进制不接受它。

→ [第 03 章的三条传输骨架](/ch03/common-skeleton)、[第 04 章的响应模式](/ch04/response-modes)

## 6. BagPipe 是 planned controller

参数由 PS 拥有，GPU 上只是有界缓存加淘汰策略。`read_mode=bagpipe` 不会自动启用 C++ 侧 GPU cache；
TTL 与 `controller.py` 那一套只在单测和显式 `enable_gpu_cache()` 路径上生效。

→ [第 02 章的 BagPipe 驻留](/ch02/bagpipe)

## 7. tiered 有四种策略

`none`（按水位一次性安放）、`lru`（预扣预算的 SSD 读缓存）、`clock`（DRAM/SSD 按热度交换，
可选异步回写，代价是失去零拷贝与 RDMA backing）、`adaptive`（按 `expected_dram_bytes` 自选）。
库与 benchmark server 模板默认 `none`，`rs_demo` 的 tiered 配置默认 `clock`。
另有与策略正交的 `dram_keys_path`（历史热度名单）与 `online_admission`（二次未命中在线换位，
要求引擎侧版本 `f8fde5af4` 起的接线；打开后读路径全拷贝）。

→ [第 05 章的分层策略](/ch05/tiering)

## 8. 存储默认不持久

`ShmFile::ConfigForMedium("DRAM")` 实际是匿名 `mmap`；PetKV 显式拒绝 checkpoint 与 clear；
只有 `clock` 策略会在运行期搬动已有行。把“共享内存”“持久内存”当 checkpoint 会直接丢数据。

→ [第 05 章的写路径与退役](/ch05/write-path)

## 9. bRPC 没有 checkpoint

协议缺 `SAVE/LOAD_CHECKPOINT`，客户端显式打 `ERROR` 并返回 `false`，不再静默失败，
但也没有回退路径——要存就得切 gRPC。

→ [第 03 章的一致性与 checkpoint](/ch03/consistency)

## 10. 观测通道可配

`report()` 的 sink 由顶层 `observability`（`remote` / `csv` / `jsonl` / `glog` / `none`）选择，
旧 `report_API` 仅作兼容；`USE_PERF_REPORT` 不再限定 Debug 构建。

→ [第 06 章的基准地图](/ch06/benchmark-map)

---

事实之外还有两类东西需要单独看：[风险总表](/quality/risks)（会咬人的行为）与
[未确认清单](/quality/unknowns)（还没验证的推断）。

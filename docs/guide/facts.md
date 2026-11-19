---
title: 十条核心事实
description: 七章共同核对过的十条结论，先记住这些，再看各章细节。
outline: [2]
---

# 十条核心事实

这十条是七章交叉核对后剩下的骨架。下面每条都用日常话讲一遍，具体的名字集中在页末那张表里，
按编号查就行。细节与例外在后面各章。

## 1. 只有一次跨进程

从 Python 到 C++ op、到客户端、到分片层，全在训练进程里；服务进程内部的分层同样如此。
整条链上真正跨过进程边界的只有一次：客户端把请求发给参数服务器。

→ [第 01 章的三层调用链](/ch01/call-chain)、[第 03 章的客户端栈](/ch03/client-stack)

## 2. 默认存储组合是全 DRAM

开箱即用的组合是哈希索引加 DRAM 值存储再加并发 slab 分配器。
SSD、NVM、分层都是可选路径，不是默认。

→ [第 05 章的组合矩阵](/ch05/composite-matrix)

## 3. key 空间由编号与标签拼成

逻辑 key 是「编号 + 标签」，标签占高 8 位，于是多张表可以共用一个 key 空间。
落哪个分片看哈希取余；每个分片由一个独立服务进程独占。

→ [第 03 章的分片与路由](/ch03/sharding)

## 4. 学习率现在跨进程可见

客户端会把学习率随请求送到服务端，三套协议各带一份副本；服务端发现与优化器不一致就整批拒绝。
传统模块仍是在客户端乘学习率，同一张表换模式会当场抛错。

→ [第 01 章的两种更新语义](/ch01/write-path)、[第 02 章的梯度提交](/ch02/write-path)

## 5. 四类传输，自动取值不在二进制里

gRPC、bRPC、RDMA、共享内存四条路径。RDMA 的读有两种响应模式：直接寻址和先拷贝。
工具层那个「自动」取值只是命令行解析，二进制只接受两个具体值。

→ [第 03 章的三条传输骨架](/ch03/common-skeleton)、[第 04 章的响应模式](/ch04/response-modes)

## 6. BagPipe 是计划式控制器

参数由参数服务器拥有，GPU 上只有有界缓存加淘汰策略。
打开读模式不会自动启用 C++ 侧缓存；另一套实现只在单测和显式开启时才生效。

→ [第 02 章的 BagPipe 驻留](/ch02/bagpipe)

## 7. 分层存储有四种策略

不淘汰、读缓存、按热度交换、按预算自选，四选一。
库和基准模板默认不淘汰，演示程序默认按热度交换。另有两个与策略正交的开关：历史热度名单与在线换位准入。

→ [第 05 章的分层策略](/ch05/tiering)

## 8. 存储默认不持久

DRAM 那一档其实是匿名映射，共享内存引擎显式拒绝存档与清空。
把「共享内存」当成能存档的地方，会直接丢数据。

→ [第 05 章的写路径与退役](/ch05/write-path)

## 9. bRPC 没有 checkpoint

协议里没有存档命令，客户端会显式报错并返回失败，不再静默。
但它也没有回退路径——要存档就得切到 gRPC。

→ [第 03 章的一致性与 checkpoint](/ch03/consistency)

## 10. 观测通道可配

上报的去处由顶层配置选：远端、CSV、JSONL、日志或关掉；旧开关只作兼容，且不再限定调试构建。

→ [第 06 章的基准地图](/ch06/benchmark-map)

## 代码里的名字

| # | 名字 |
| --- | --- |
| 1 | `RecStoreClient`、`KVClient`、`torch.ops.recstore_ops`、`KVClientOp`、`CreatePSClient`、`PSClientType`、`kGrpc`、`kBrpc`、`kRdma`、`kLocalShm`、`ShardClient`、`CachePS`、`BaseKV`、`KVEngineComposite` |
| 2 | `DRAM_PET_HASH`、`DRAM_VALUE_STORE`、`CONCURRENT_SLAB_MEMORY_POOL` |
| 3 | `(id, tag)`、`tag`、`hash(key) % num_shards`、`CachePS` |
| 4 | `update_async`、`local_update_flat`、`emb_update_table`、`learning_rate`、`lr`、`CachePS::CheckLearningRate`、`DistEmbedding`、`(client, table)`、`_record_table_update_mode` |
| 5 | `direct_sg`、`staging_copy`、`auto`、`run_benchmark_ps.py`、`rs_demo/cli.py` |
| 6 | `read_mode=bagpipe`、`controller.py`、`enable_gpu_cache()` |
| 7 | `none`、`lru`、`clock`、`adaptive`、`expected_dram_bytes`、`rs_demo`、`dram_keys_path`、`online_admission`、`f8fde5af4` |
| 8 | `ShmFile::ConfigForMedium("DRAM")`、`mmap`、`PetKV`、`clock` |
| 9 | `SAVE/LOAD_CHECKPOINT`、`ERROR`、`false` |
| 10 | `report()`、`observability`、`remote`、`csv`、`jsonl`、`glog`、`none`、`report_API`、`USE_PERF_REPORT`、`Debug` |

事实之外的推断与风险，按章收在各章末尾的「风险」与「证据索引」里。

---
title: 第 10 块：配置与开关
description: 一条配置要生效，链路上必须有一个真正的读取者。
outline: [2, 3]
---

## 它是什么

一条配置要生效，链路上必须有一个真正的读取者。这一块把选型、分片、槽位与两条网络传输会读的键集中列出，并标出那些看起来像开关、实际没有读取者的键。

## 它为什么存在

读配置时最常见的误判是把「写进 JSON 的键」当成「运行时生效的开关」。把默认值与作用放在一起，是为了让「改了没反应」在阅读阶段就能排除，而不是等跑一次基准才发现键根本没人读。

## 它和谁接

上接[第 2 块](./client-stack)的选型链与[第 8 块](./local-shm)的槽位参数；下游是[第 04 章](../ch04/)的 RDMA flag 表与[第 05 章](../ch05/)的存储引擎配置。表里存储引擎那两项只影响 PS 核心之下，不在本章展开。

## 代码位置

| 配置 / flag | 默认值 | 作用 |
| --- | --- | --- |
| `cache_ps.ps_type` | 客户端与服务端入口默认 `GRPC` | 选择传输 |
| `cache_ps.num_shards` | 1 | 分片数；>1 时服务端要求 `servers` 齐全且数量相等 |
| `cache_ps.servers[]` | — | `{host, port, shard}`；单分片时也决定监听地址 |
| `cache_ps.num_threads` | schema 必填 | KV 引擎线程数；local_shm 缺失时按 1 处理并抬到 ≥ `ready_queue_count` |
| `cache_ps.max_batch_keys_size` | 已废弃 | 服务端检测到只打 `WARNING` 并忽略；批量上限由 `distributed_client.max_keys_per_request` 控制 |
| `cache_ps.base_kv_config` | — | 存储引擎配置，见第 05 章 |
| `distributed_client.num_shards` | 由 `servers.size()` 推导 | 客户端路由模数 |
| `distributed_client.hash_method` | `city_hash` | `city_hash` / `simple_mod` |
| `distributed_client.max_keys_per_request` | 500 | 单 shard 单 RPC 的 key 上限 |
| `client.host/port/shard` | `127.0.0.1:15000`, shard 0 | 合成单分片配置时的地址 |
| `local_shm.region_name` | `recstore_local_ps` | POSIX shm 名称 |
| `local_shm.slot_count` / `slot_buffer_bytes` | 64 / 8 MiB | 槽位数（并发上限）/ 单请求最大载荷，后者同时决定 GET/PUT 的自动切块 |
| `local_shm.ready_queue_count` / `ready_queue_burst_limit` | 1 / 8 | ready 队列与 worker 数 / 单次 drain 的最大槽位数 |
| `local_shm.client_timeout_ms` | 30000 | 客户端等待槽位/完成超时（含建表请求） |
| `local_shm.thread_ready_queue_sharding` | false | 按线程分散 ready queue |
| `local_shm.ready_queue_index` / `client_rank` / `rank` / `local_rank` | — | 选择 ready queue；依次回退，也读 `RECSTORE_LOCAL_SHM_READY_QUEUE_INDEX`、`LOCAL_RANK`、`RANK` |
| `-get_parameter_threads` | 4 | 构造 `stubs_` 数量；实际调用总用 `stubs_[0]` |
| `-brpc_timeout_ms` / `RECSTORE_BRPC_TIMEOUT_MS` | 5000 | bRPC 请求超时 |
| `-brpc_max_retry` | 3 | bRPC 传输层重试次数 |
| `-brpc_ps_use_rdma` / `RECSTORE_BRPC_USE_RDMA` | false | bRPC 走 RDMA（需编译期支持）；`RECSTORE_BRPC_RDMA_DEVICE` 选 HCA（映射 `-rdma_device`） |
| `-grpc_local_shard_id` / `-local_shard_id` | -1 | 一进程只起指定 shard |
| `-brpc_server_port` / `-brpc_server_num_threads` | 15000 / 0（auto） | bRPC 单分片监听端口（`servers` 缺失时的回退值）/ 线程池大小 |
| `-value_size` / `-max_kv_num_per_request` | 128 B / 300 | PS 级缓冲估算，主要用于基准和 RDMA 适配层 |

## 交付一句

配置与开关到此交代完毕：三层来源、一张默认值表、一处已废弃但仍被 schema 接受的键。接下来是与相邻章节的接口、风险清单与证据索引。

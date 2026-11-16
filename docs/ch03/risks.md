---
title: 风险、坑与未确认点
description: bRPC 没有 checkpoint，只有显式失败，没有回退路径。
outline: [2, 3]
---

1. **[源码事实] bRPC 没有 checkpoint，只有显式失败，没有回退路径。** 协议缺两个枚举，客户端 override 打 `ERROR` 返回 `false`，`Command` 也显式报 unsupported。调用方现在能拿到失败，但仍只能改用 gRPC；若把 `false` 当作可重试失败，会一直重试一条永不可能成功的路径。
2. **[源码事实] gRPC 单分片客户端并发不安全。** 所有 RPC 都用 `stubs_[0]` 且共享同一个 `cq_`；`get_parameter_threads` 创建的其余 stub 从未使用，`get_param_*` 成员也是共享可变状态，多个线程同时对同一分片调用 `GetParameter` 会互相取走完成事件。预取有自己的 CQ 与 `prefetch_mu_`，不受影响；bRPC 客户端的预取表则连互斥都没有。
3. **[源码事实] 普通 Update 的传输层重试可能重复应用。** bRPC `max_retry=3` 对连接类失败自动重试；`UpdateParameter`/`PutParameter` 没有请求 id 或幂等键，重试可能把同一批梯度应用两次。`SparseGradientCommit` 有 `(step, chunk)` 去重，是唯一被显式保护的写路径。
4. **[源码事实] 未知命令会杀死服务端进程。** 两个服务端的 `Command` 末尾都是 `LOG(FATAL)`；新旧客户端/服务端混部或手工发错枚举值时，故障是进程级而不是请求级。
5. **[源码事实] bRPC 把空 payload 当成「无行」。** 正常与预取路径都跳到下一块并保持 0，不返回错误；gRPC 在同样情形已返回 -1。对端截断响应或连到非预期 PS 时，bRPC 侧仍会静默产出全 0 的行。
6. **[源码事实] local_shm 的 epoch 没有真正生效。** 客户端写入 `server_seen_epoch`，服务端从不比较；`server_epoch` 在 `Create` 时恒置 1，`kEpochMismatch` 从未使用。服务端重启并重建同名 region 后，仍挂着旧映射的客户端不会被拒绝。
7. **[源码事实] local_shm 的槽位释放队列与获取队列不一致。** `AcquireSlot` 从 `free_queue_header(CurrentReadyQueueId())` 取槽，`ReleaseSlot` 却把槽还到 `free_queue_header(slot_id % ready_queue_count())`。当 `ready_queue_count > 1` 且多个客户端/队列并存时，某个队列可能长期拿不到槽位而饥饿；是否会在真实负载下形成死锁未确认。
8. **[源码事实] local_shm 只适用于 Linux 单机，且没有控制面。** `Command()` 是空实现，没有 CLEAR/RELOAD/checkpoint；`shm_open`/`futex` 决定它无法跨主机，也无法在 Windows 或非 Linux 容器外运行。
9. **[待验证] `tid` 语义在传输间不一致。** gRPC/bRPC 处理器固定 `tid=0`，与 gRPC 线程池的实际并发无关；local_shm 每个 worker 用不同 `tid`。存储引擎是否要求 `tid` 唯一、`tid=0` 在并发下是否安全，需[第 05 章](../ch05/)确认。
10. **[源码事实] 建表 RPC 在 gRPC 客户端没有 deadline。** 其余 RPC 通过 `SetRpcDeadline` 设置 15 s（checkpoint 600 s、`LoadCkpt` 30 s），唯独 `InitEmbeddingTable` 没有；服务端卡住时该调用会无限等待。local_shm 的建表请求由 `client_timeout_ms` 约束，不受此影响。
11. **[源码事实] 分片写没有原子性。** 跨 shard 的 Put/Update/SparseGradientCommit 都是「逐 shard 串行/并行发送」，中途失败不会回滚已成功的分片；训练侧若直接重试整批，可能造成部分 shard 重复更新。
12. **[源码事实] 稀疏提交依赖所有 rank 齐全。** v1 的聚合顺序不依赖到达顺序，但依赖所有 rank 都提交齐全；缺失一个 rank 会永久停在 in-flight（直到会话被 abort 或 close）。会话没有超时清理机制。
13. **[源码事实] 文档与配置 schema 仍与代码不一致。** `docs/parameter_server/grpc.md` 称 `GRPCParameterClient` 继承 `BasePSClient` 且只有单个 `stub_`，实际继承 `ShardClient`、持有 `stubs_` 向量；`docs/parameter_server/proto.md` 称两份协议结构类似，未提 bRPC 少两个 checkpoint 枚举；`docs/parameter_server/base.md` 把 `shard_manager.h` 笼统写作「分片管理」，实际只服务离线加载；`tools/config/recstore_config.schema.json` 的 `ps_type` enum 只列 `GRPC`/`BRPC`，而 C++ 适配层还接受 `RDMA`/`LOCAL_SHM`。以代码为准。

## 近期已修复（5f92ba2a → 6d205e98）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| gRPC GetParameter 失败静默补零 | 15 s deadline；传输未完成、完成但 status 非 OK、空 payload、行数不符都返回 -1，分片层整批失败 | `e2efe502` |
| gRPC 预取失败无感知 | `MarkPrefetchFailed`/`ConsumePrefetchCompletion` 记录首个失败原因，失败批次视为已完成；200 ms × 150 轮（30 s）空闲判超时 | `e2efe502` |
| bRPC checkpoint 静默返回 false | 客户端显式打 `ERROR`，`Command` 显式报 unsupported；协议仍无枚举 | `c77f5461` |
| 单分片监听地址硬编码 `0.0.0.0:15000` | `SelectSingleShardEndpoint` 优先取 `cache_ps.servers`，缺失才回退默认；gRPC 用真实 shard id 注入 checkpoint metadata | `95616eef` |
| `max_batch_keys_size` 被当作运行时开关 | 服务端 `WARNING` 并忽略，批量由 `distributed_client.max_keys_per_request` 控制 | `5530c44a` |
| checkpoint 失败定位不到分片 | 逐分片收集结果，打印 shard 号与文件路径，并汇总 `failed/total` | `e2efe502` |

## 本轮已修复（6d205e98 → 7c44f83da）

| 问题 | 现在的行为 | commit |
|--------|------------|--------|
| 客户端学习率跨进程完全不可见，两侧 lr 不一致时无人察觉 | 两份 proto 的 `UpdateParameterRequest` 加 `optional float learning_rate = 3`，local_shm 复用槽位头里的 `reserved0`，RDMA 适配层一并透传 | `606d86f5` |
| 客户端与服务端 lr 不一致时静默按服务端 lr 更新 | `CachePS::CheckLearningRate` 校验后拒绝，打 `ERROR` 并让整批更新失败 | `8a63bfed` |
| 分片与 HierKV 路径丢掉了 lr | `update_async` / `local_update_flat` / `emb_update_table` 一路带到 PS，含分片与单机分布式路径 | `606d86f5` |

---
title: 第 9 块：一致性与 checkpoint
description: 一致性只回答三件事：写入顺序、重复提交是否被应用两次、重启后能恢复到哪里。
outline: [2, 3]
---

## 它是什么

一致性在这一层只回答三件事：写入按什么顺序生效、重复提交会不会被应用两次、进程重启后能恢复到哪个点。三条传输对前两件答案相近，对第三件只有 gRPC 有答案。

顺序方面，gRPC/bRPC 没有 epoch 或租约概念，依赖「单 shard 单写者 + 请求内顺序」。local_shm 定义了 `server_epoch` 与槽位上的 `server_seen_epoch`，客户端每次提交都写入当前 epoch，但服务端从不读，`kEpochMismatch` 只出现在枚举里。也就是说 epoch 只是记录，不是屏障。

## 它为什么存在

训练侧的重试不可避免：连接会断，进程会重启。没有 step 级去重，一次重试就可能把同一批梯度应用两次；没有 checkpoint 身份约束，一次误操作就可能用旧存档覆盖新状态。这一块是所有上层逻辑的隐式前提。

## 它和谁接

上游是三条传输的写路径，下游是[第 05 章](../ch05/)的存储格式与 checkpoint 记录数。它同时约束[第 02 章](../ch02/)训练循环的行为：分片写没有原子性，整批重试必须由调用方判断。

## 代码位置

checkpoint 全链路与各处失败表现：

- `DistributedShardedClient::SaveCheckpoint/LoadCheckpoint` 并发 fan-out 到每个配置 shard，路径为 `<path>/recstore-shard-<shard>.bin`（`ShardCheckpointPath`）；逐分片收集结果，失败时打印 shard 号与文件路径，并汇总 `failed/total`；任一失败返回 `false`。
- gRPC 服务端校验 `arg1/arg2` 各一个且非空，解析 metadata JSON，要求含 `identity` 对象与非空 `checkpoint_id`，注入本 shard 的 `shard_id` 后调用 `CachePS`；参数不合法返回 `INVALID_ARGUMENT`，保存/加载失败返回 `FAILED_PRECONDITION`。
- `CachePS` 的约束：save 成功后记录 `active_checkpoint_identity_` 并清除 dirty；load 在「有未保存更新（dirty）」「已有不同 active identity」「存储里已有 checkpoint 记录（非 fresh）」三种情况下抛异常；失败或异常时按 `CheckpointRecordCount()` 回填 dirty。
- bRPC 客户端 `SaveCheckpoint`/`LoadCheckpoint` 重写为打 `ERROR` 并返回 `false`，`Command(SAVE/LOAD_CHECKPOINT)` 同样显式报 unsupported；协议里仍没有对应枚举。local_shm 没有 override，走 `BasePSClient` 默认实现，也是打 `ERROR` 返回 `false`。

读写顺序与幂等性：

- `SparseGradientCommitCoordinator` 为每张表维护一个 in-flight step：要求 `step == committed + 1`；按 `(rank, chunk)` 缓存分片；固定 rank/chunk 顺序聚合，网络到达顺序不影响结果；重复提交旧 step 时，payload 与已缓存一致则幂等返回 `committed`，不一致则抛错。
- v4「exact owner replacement」额外要求 `world == 2`、`dim == 128`、key 严格递增、值全部有限、payload ≤ 1 MiB、chunks ≤ 64，并且要求 key 的高 8 位已带目标表的 tag（`TAG_TYPE` 为 `uint8_t`，`KeyTagShift() == 56`；tag 由 `MakeTensorTag(table_id, role, tensors_per_table)` 生成）；失败后会话置为 sticky failed，不重试、不回退。
- 普通 `UpdateParameter` / `PutParameter` 没有请求级去重；bRPC 的 `max_retry` 是传输层重试，对非幂等更新存在重复应用风险。

写路径的落地方式与切块：

- 服务端聚合对同一 key 做累加（v1）或整行替换（v4）；`divisor != 1` 时对聚合结果整体除以 `divisor`。稀疏提交客户端默认 payload 上限 256 KiB，大 step 按 `(limit - sizeof(h)) / (8 + dim*4)` 自动分 chunk；local_shm 覆盖为 `slot_buffer_bytes - 4096`。
- 三条路径的 Put 落地方式不同：bRPC 服务端逐 key 调用 `PutSingleParameter`，gRPC 服务端整批交给 `CachePS::PutParameter`（内部 `BatchPut`），local_shm 走 `PutDenseParameterBatch`。

## 交付一句

一致性与 checkpoint 到此交代完毕：一条路径能存档、一套 step 级去重、一批没有原子性的分片写。下一块讲这些行为由哪些配置键决定。

---
title: 第 7 块：错误分层与恢复
description: 错误按检测点分成七层，每层一种异常类型，并明确是否置脏、能否重建。
outline: [2, 3]
---

## 它是什么

错误按检测点分成七层，每层对应一种异常类型，并明确两件事：要不要把 lane 置脏、能不能靠重建治好。verbs 完成状态又单独分成五类，只有两类值得重建。重试本身也分层：硬件层、传输层、lane 层是真的在做重试，请求层根本没有重试。

| 层 | 检测点 | 抛出的类型 | 是否置脏 lane | 能否靠重建恢复 |
| --- | --- | --- | --- | --- |
| 参数 / 容量 | slot 装不下、batch 超预算 | `std::runtime_error` / `std::invalid_argument` | 否 | 改参数 |
| verbs post | `ibv_post_send` 返回非 0 | `std::runtime_error`（`Write`/`WriteSg`） | **否** | 通常不能 |
| 设备层 | CQE `status != SUCCESS` | `RawVerbsCompletionException` / `ShardUnreachableError` | 是 | 仅 peer 侧 |
| tracked WR 超时 | signaled WR 等不到 CQE | `RcTrackedCompletionTimeout` | 是（`drain_timeout`） | 是 |
| 状态字等待超时 | 超过 `--rdma_wait_timeout_ms` | `std::runtime_error` | 是（`wait_timeout`） | 是 |
| 节点层 | `GetServerHealth` 判 `dead` | `ShardUnreachableError` | 是（`health_dead`） | 是 |
| 服务端业务 | `StatusWord::status` | 正常响应，`RpcStatus` | 否 | 由调用方决定 |

置脏的唯一入口是 `PetPSClient::MarkLaneDirty(qp_index, reason, snapshot, waited_ms, rebuildable)`：调用点分别报 `wait_timeout`、`health_dead`、`drain_timeout`（三者 `rebuildable=true`）与 `cq_harvest_exception`（`rebuildable=false`）；`FailLaneOnCompletionError` 按完成状态分类后再决定。多次置脏时 `rebuildable` 取或，一个可重建的原因不会被先前不可重建的原因掩盖。

完成事件的分类：

| 类 | 触发状态 | 含义 | `IsRawVerbsUnreachableError` |
| --- | --- | --- | --- |
| `kPeerUnreachable` | `IBV_WC_RETRY_EXC_ERR`、`IBV_WC_RNR_RETRY_EXC_ERR` | 对端不再 ACK | true |
| `kPeerRejected` | `IBV_WC_REM_INV_REQ_ERR`、`REM_ACCESS_ERR`、`REM_OP_ERR` | 对端应答但拒绝 | false |
| `kLocalError` | `LOC_LEN_QP_OP_PROT_ACCESS_RDD_VIOL` | 本地长度/权限/QP 用法错 | false |
| `kFlushed` | `IBV_WC_WR_FLUSH_ERR` | QP 已死，WR 被冲掉 | true |
| `kOther` | 其余 | 未知 | false |

只有 `kPeerUnreachable` 与 `kFlushed` 值得重建；`kPeerRejected` / `kLocalError` / `kOther` 重建治不了，`FailLaneOnCompletionError` 会保留原始 `RawVerbsCompletionException` 而不是包装成「shard unreachable」。

四层重试，只有一层是真重试：

| 层 | 机制 | 重试对象 | 默认 |
| --- | --- | --- | --- |
| 硬件 | verbs RC：`timeout=14`（≈67 ms）、`retry_cnt=7`、`rnr_retry=7`、`min_rnr_timer=12` | 单个 WQE | 恒开 |
| 传输 | 复用 slot 前先 reap 上一个 commit WR 的 CQE | 完成事件 | 恒开 |
| lane | QP 重建 + 双边 generation 握手 | 整条 lane | `--rdma_lane_rebuild_enabled`，默认关 |
| 请求 | **不存在** | — | — |

## 它为什么存在

请求层不重试是有意的：重建后无法确定服务端是否已经执行过该请求，而更新会真的改梯度。异常只带拼好的文本，没有结构化 shard/lane 字段，所以上层还做不到「只重试失败的那一片」。把这条边界写清楚，比补一个看似智能的重试更有价值。

## 它和谁接

上游是[第 1 块](./slot-protocol)的提交等待与[第 8 块](./lane-lifecycle)的重建判定（本节只回答「谁检测、谁标记」，「标记之后谁来重建」在下一块）；下游是调用方的整批重试策略。slot 的簿记在这里收尾，因为失败时的释放语义直接决定调用方会不会读到一份从没到达的结果。

## 代码位置

slot 状态回滚：`SlotContext::busy` 与 `pending_rpcs_` 是两套簿记，失败时的处理不对称。

- 重建后 `slot.busy = false`（QP reset 后 slot 物理上可用），但 `PendingRpc::failed = true` 且条目保留。原因写在 `TryRebuildLaneLocked`：删掉条目会让 `QueryRPCFinished` 返回 true、`WaitRPCFinish` 静默返回，调用方会去解一个从没到达的响应（零填缓冲区恰好解成 `RpcStatus::kOk`）。
- `RevokeRPCResource` 对 `failed` 条目跳过 `ClearRequestSlot`，因为该 slot 可能已经被新请求复用，清零会破坏新请求的 commit 字。
- 脏 lane 上的 slot 一律不归还（`revoke_skipped_dirty_lane`）：服务端可能仍在读请求 payload，或 CQE 还会晚到。

其余符号：`ClassifyRawVerbsCompletionStatus` 与 `IsRawVerbsUnreachableError` 在 `raw_verbs_transport.h`；等待循环里的健康探测与 CQE 收割在 `petps_client.cc#PetPSClient::WaitForStatusWord`；慢路径探测的节流与缓存在 `control_plane.h#RdmaSlowPathProbeGate`、`petps_client.cc#MaybeProbeShardHealth`。

## 交付一句

错误分层与恢复到此交代完毕：七层错误、两类值得重建的完成状态、四层重试里唯一缺失的那层。下一块接[第 8 块](./lane-lifecycle)，讲被标记为脏且可重建的 lane 怎么恢复。

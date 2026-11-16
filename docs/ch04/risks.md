---
title: 风险、坑与未确认点
description: 2026-11-09 的基线没有改动 RDMA 路径；下面 12 条结论都未因此改变。
outline: [2, 3]
---

2026-11-09 的基线（`5f92ba2a` → `6d205e98`）没有改动 RDMA 路径；2026-11-11 合并的 `7c44f83da` 只做两件事：descriptor 的 `reserved0` 改为 `learning_rate`（UPDATE 三类入口都填），以及上游修 `docs/parameter_server/rdma.md` 的 `auto` 段落。下面 12 条结论都未因此改变，第 5 块的不一致项已按上游文档改后状态更新。

1. **[源码事实] `direct_sg` 的 payload 与并发 UPDATE 无同步。** `HandleGetDirectSg` 把 KV value 区里的行地址填进 SGE 并 post WRITE 后立刻返回，NIC 之后才异步读取这些字节；同一 shard 的另一个 poll 线程可以同时对同一 key 执行 `ApplySgdUpdateFlat`，而它对 `row.data` 是原地 `value[c] -= learning_rate * grad[c]`（`engine_composite.h#ApplySgdUpdateFlat`），不是写时复制。协议层不会损坏内存，但一次响应可能读到半新半旧的行。代码里没有任何按行的锁或版本号，影响面取决于训练负载是否并发读写同一 key，未实测。
2. **[源码事实] 服务端 MR 数量随 lane 线性放大。** `RegisterLocalMemoryRegion` 对每条 lane 各注册一次整块 KV value 区，加上零区与 lane 自身的 slot 区，稳态约为 `lanes × 3` 个 MR。默认 16 lane 时，一块多 GB 的 value slab 会被注册 16 次，注册耗时与 NIC 页表压力都随 `qps_per_client_per_shard` 增长。改小 QP 数或共享 PD 是可行方向，当前实现没有共享。
3. **[源码事实] `ibv_post_send` 失败不会置脏 lane。** `RawVerbsTransport::Write` 失败抛普通 `runtime_error`；`SubmitRpcLocked` 只捕获 `RawVerbsCompletionException` 与 `RcTrackedCompletionTimeout`，所以 post 失败既不置脏 lane，也不复位该 slot 的 `busy`（`GetParameter` 只在容量校验失败时手动复位），这条 lane 的容量会被永久吞掉一块。仓库文档 `docs/parameter_server/rdma.md` 把它标为「已知缺口」，与代码一致。
4. **[源码事实] `payload_offset` 是残留字段。** 协议允许任意 `>= 192` 且不越界的值通过校验，但服务端始终从 192 读 payload。第三方客户端按该字段布局时会静默错位。
5. **[源码事实] `direct_sg` 的静默性能悬崖。** `default_value_size_hint != embedding_dim*4`、或 value store 不是 DRAM 时，每一批都会在 `HandleGetDirectSg` 里 abort 再整批回退，只留下 `get_direct_sg_fallback` 计数。功能正确，但基准数字会变成 staging_copy 的开销，客户端毫不知情。
6. **[源码事实] `HasAvailableSlots` 的语义偏保守。** 任一 lane 处于 `dead` 或 `dirty` 就返回 false，即使其余 15 条健康。它只被 `PrefetchParameter` 用来决定是否 `DrainBatchSlots`，不会直接报错，但会让一次预取把全部在途 batch 收干。
7. **[源码事实] NUMA flag 在 C++ 侧未接线。** `--rdma_rc_client_numa_id` / `--rdma_rc_server_numa_id` 只在 `rc_options.cc` 定义、被 Python runner 读取来决定 `RECSTORE_BIND_CORE_OFFSET` 与 CPU 亲和；`RawVerbsTransport` 从不读它们，也没有 `ibv` NUMA 相关调用。真正的亲和来自 `base::bind_core_with_env_offset`。
8. **[源码事实] 没有 GPU Direct / DMABUF。** `src/ps/rdma/` 内没有 cuda / dmabuf / peer-memory 调用；所有 RDMA 只发生在主机内存的 slot 与 value 区之间，GPU tensor 必须先经 `memcpy` 落到用户缓冲区。
9. **[源码事实] `SendDoorbell` 是死代码。** `RawVerbsTransport::SendDoorbell`（`IBV_WR_SEND_WITH_IMM`）在仓内没有调用点；`TryPoll` 对 `RECV` 完成的重挂逻辑目前只是防御性代码。
10. **[源码事实] draining 流程未上线。** `PublishServerDraining` 只在单测里被调用；`PetPSServer::Stop` 明确注释「不发 draining」，因为当前没有消费者，而 draining 记录会永久拒绝同 epoch 的 READY。`WaitServerReady` 同样只出现在测试里，生产客户端用的是 `WaitServer(shard)`。
11. **[待验证] 重建恢复包线未复测。** `docs/parameter_server/rdma.md` 给出实测「设备层发现对端不回 ACK 4.2–4.4 s」「默认恢复包线 ≈13.3 s，之后终态 `dead`」；本轮只核对了参数（`timeout=14`、`retry_cnt=7`、3 次重建、2 s 握手、1 s 冷却）与「预算按 lane 终身累计、成功后不复位」这一实现细节，没有在真实 RDMA 环境复现这两个数字，差距原因也未定位。需要一次带 `--rdma_rc_profile_interval_ms` 与 `--rdma_rc_server_fence_stats_interval_ms` 的实测才能确认。
12. **[源码事实] `RECSTORE_RDMA_GET_RESPONSE_MODE` 与 flag 双入口的优先级。** `ApplyRdmaFlagsFromEnv` 在适配器初始化时覆盖 flag；直接跑 C++ benchmark 时以命令行 `--rdma_get_response_mode` 为准。两条入口没有冲突检测，同时设置时环境变量赢。

## 文档与代码不一致

| 条目 | 现状 |
| --- | --- |
| 每 lane 注册内存尺寸 | `docs/parameter_server/rdma.md` 第 94 行仍是「注册内存（默认 128 MiB）」，与[第 2 块](./connect-mr)的 `ClientLaneBytes` / `ServerLaneBytes(+staging)` 不符：结构体默认值确实 128 MiB，但实际注册长度按 lane 切片（默认客户端每 lane 2 MiB）。 |
| `--rdma-get-response-mode` 取值 | 该文第 205 行已改对（"`auto` 只是解析层"），但第 238 行的配置表仍把 `auto` 列入取值；二进制只接受 `direct_sg` / `staging_copy`（见[第 5 块](./response-modes)）。 |

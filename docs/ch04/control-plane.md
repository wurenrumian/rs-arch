---
title: 第 6 块：控制面与部署
description: 控制面是一个 gRPC 服务，只跑在编号为 0 的服务端进程里，走 TCP。
outline: [2, 3]
---

## 它是什么

控制面是一个 gRPC 服务，只跑在编号为 0 的服务端进程里，走 TCP，默认监听 `127.0.0.1:25100`——这是与数据面 RC QP 完全分离的另一条连接。它保存三张表：元数据表、就绪表、健康快照。元数据按「部署 id + epoch + 发布方/接收方节点与 lane」索引，就绪表按「部署 id + epoch + 服务端编号」索引，健康快照按心跳时间裁决 stale 与 dead。任意 server 或 client 进程都持有一个控制面客户端，每条连接一个 channel 并复用。

## 它为什么存在

数据面没有「连接建立」这一步，谁都可以往对端的 rkey 上写。要让这种自由安全，必须在带外确认三件事：对端和我属于同一次部署、对端的 QP 元数据是最新的、对端还活着。控制面就是这三件事的唯一入口；它一旦被绕过，数据面会把请求写进错误的世代或错误的进程。

## 它和谁接

上游是进程启动时的部署配置，下游是[第 8 块](./lane-lifecycle)的重建握手（世代号通过元数据交换）与健康探测（dead 判定会把 lane 置脏）。它不参与任何读写请求，因此控制面的抖动只影响恢复速度，不影响稳态吞吐。

## 代码位置

拓扑与编号：

- `ParseResolvedRdmaDeploymentConfig` 要求 `distributed_client` 与 `rdma_deployment` 同时存在，少一个字段就抛 `invalid_argument`。`distributed_client` 显式 `num_shards`、`hash_method`（`city_hash` / `simple_mod`）、`max_keys_per_request`、`servers[]`（每个 shard 一条，含 host/port/shard，必须覆盖全部 shard、不能重复）。
- `rdma_deployment`：`deployment_id`（非空）、`epoch`（>0）、`protocol_version`（必须等于 `kRdmaDeploymentProtocolVersion == 1`）、`num_clients`（>0）、`nodes[]`。`nodes[]` 必须覆盖 `num_shards + num_clients` 个节点，每个要有 `node_id`、`role`、`device`、`port`、`gid_index`；`role` 必须与 node_id 区间一致（server `[0, num_shards)`，client `>= num_shards`）；RoCE v2 还强制要求 `hop_limit` / `traffic_class` / `flow_label` 且在范围内。
- `configuration_digest` 是规范化（按 shard / node_id 排序）后的整份配置的 FNV-1a 十六进制摘要；`fabric_digest` 只对 `nodes[]` 做同样摘要。两个 digest 都进入 meta 与 READY 校验。
- 节点编号是稠密的：`global_id < num_servers` 是 server，否则是 client，客户端 `logical_id = global_id - num_servers`。

启动顺序：

1. `global_id == 0` 的服务端先 `RdmaControlPlaneServer::Start()`（gRPC，默认 `127.0.0.1:25100`）。
2. 每个服务端构造 `RcShardServerTransport`：每 lane 建资源 → `PublishAndConnect()`（发布本端 QPN/generation，拉取所有已连接对端 meta，做 `ValidateRawVerbsPeerMeta`）→ 挂 receive WR。
3. 服务端轮询线程全部起来后，`MaybePublishServerReady` 只由最后一个线程触发一次 `PublishServerReady`。心跳线程与 READY 独立：它只刷新已存在的 READY 记录，不会创建记录（`RecordHeartbeat` 直接 return）。
4. 客户端 `PetPSClient::InitializeTransport`：解析同一份配置 → 建 `RcShardClientTransport`（同样逐 lane 建连）→ `WaitServer(shard)` 阻塞到该 shard READY → 再 `OpenSlot` 建立 slot 视图。
5. `InitEmbeddingTable` 走正常 `kInitTable` 请求，把表建出来后才开始 GET/PUT。

`ValidateRawVerbsPeerMeta` 逐字段比对 node_id、logical_id、node_role、protocol_version、deployment_id、deployment_epoch、两个 digest、link_layer、fabric_mode、port、gid_index、active_mtu。任何不一致都在建连阶段快速失败，这是「同一次部署」的硬边界。

关键 flag（`rc_options.cc` 是权威默认值）：

| flag | 默认 | 影响 |
| --- | --- | --- |
| `--rdma_rc_qps_per_client_per_shard` | 16 | 每 client 每 shard 的 lane 数（结构体默认 32，被该 flag 覆盖） |
| `--rdma_rc_slots_per_qp` | 1 | 每条 QP 的逻辑 slot 数；在途上限 = 两者乘积 |
| `--rdma_rc_request_slot_bytes` / `--rdma_rc_response_slot_bytes` | 1 MiB / 1 MiB | slot 尺寸 |
| `--rdma_rc_mtu_bytes` / `--rdma_rc_target_response_mtu` | 4096 / 200 | GET 单 RPC key 上限 = `(4096*200)/value_size` |
| `--rdma_rc_inline_bytes` | 64 | 申请 `max_inline_data`；≤ 该值的 WRITE 加 `IBV_SEND_INLINE` |
| `--rdma_wait_timeout_ms` | 60000 | 状态字等待预算 |
| `--rdma_cq_harvest_interval_ms` | 50 | 等待期收割 CQE 的间隔（0 关闭） |
| `--rdma_health_probe_after_ms` / `_interval_ms` / `_timeout_ms` | 1000 / 1000 / 1000 | 慢路径健康探测 |
| `--rdma_heartbeat_interval_ms` / `--rdma_health_stale_ms` / `--rdma_health_dead_ms` | 1000 / 3000 / 9000 | 心跳与健康阈值 |
| `--rdma_lane_rebuild_enabled` | false | 是否允许 QP 重建自愈（两端须同时开启） |
| `--rdma_lane_rebuild_max_attempts` / `_cooldown_ms` / `_wait_ms` | 3 / 1000 / 2000 | 重建预算、冷却、握手期限 |
| `--rdma_lane_rebuild_poll_ms` / `_poll_max_ms` / `_poll_timeout_ms` | 50 / 500 / 100 | 服务端世代轮询与退避 |
| `--rdma_rc_server_get_workers` | 0 | GET payload 卸载线程数，0 = poller 内联 |
| `--rdma_rc_server_coroutines_per_thread` | 1 | 每 poll 线程的协作式 scanner 数 |
| `--rdma_rc_profile_interval_ms` | 0 | 周期性 profile 输出 |

## 交付一句

控制面与部署到此交代完毕：三张表、一份严格契约、一条五步启动顺序。下一块接[第 7 块](./errors)，讲谁在检测故障、谁把 lane 标记成脏。

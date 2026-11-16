---
title: 文档与代码不一致
description: 上游仓库文档里仍然与代码对不上的地方，共 12 处。
outline: [2]
---

# 文档与代码不一致

这一页存在的理由很实际：上游 `docs/` 目录里的文档描述的是更早的实现。
照着它改代码会走错路，照着它排查会得出相反结论。下表每条都给“仓库文档的说法”和“代码事实”两面。

| 主题 | 仓库文档说法 | 代码事实 | 详见 |
|---|---|---|---|
| RDMA 注册内存 | `docs/parameter_server/rdma.md` 写“默认 128 MiB” | 结构体默认值如此，RC 路径按 lane 切片覆盖；默认每 lane 2 MiB | [04](/ch04/connect-mr) |
| RDMA `auto` 响应模式 | 同文配置表仍把 `auto` 列为取值（正文已澄清） | 二进制只接受 `direct_sg` / `staging_copy`；`auto` 在工具层展开 | [04 · 响应模式](/ch04/response-modes) |
| PS 继承关系 | `docs/parameter_server/grpc.md` 称继承 `BasePSClient`、单个 `stub_` | 实际继承 `ShardClient`，持有 `stubs_` 向量 | [03 · gRPC 路径](/ch03/grpc) |
| bRPC proto | `docs/parameter_server/proto.md` 称两份结构类似 | `PSCommand` 少 `SAVE/LOAD_CHECKPOINT` 两项 | [03 · 协议与命令](/ch03/protocol) |
| `shard_manager.h` | `docs/parameter_server/base.md` 写作分片管理 | 只被离线 `load_db.h` 使用 | [03 · 分片与路由](/ch03/sharding) |
| `ps_type` schema | `tools/config/recstore_config.schema.json` 的 enum 只有 GRPC/BRPC | C++ 适配层还接受 RDMA / LOCAL_SHM | [03 · 配置](/ch03/config) |
| 组合矩阵 | `docs/storage/composite_kvengine.md` 把 SSD 索引 × DRAM value 标“不推荐” | 代码不禁止，测试直接 skip；只有构造期字段检查 | [05 · 组合矩阵](/ch05/composite-matrix) |
| `KVClient.wait(handle)` | `docs/api/python.md` 称可只等待 prefetch | 只处理 update 句柄；prefetch 需 `emb_wait_result` | [02 · 读路径](/ch02/read-path) |
| 算子接入示例 | `docs/dev/feature/add_operator.md` 用 `torch.ops.load_library` 与旧签名 | 实际 `torch.classes.load_library` + 多路径发现，签名已变 | [02 · op 入口](/ch02/op-entry) |
| e2e 报告字段 | `docs/performance/e2e.md` 说报告 p50 ms/step | 实际输出 `p95_step_total_ms` 与阶段均值 | [06 · 基准地图](/ch06/benchmark-map) |
| `distributed_dlrm_training.py` | 文件头注释称接入 RecStore | 构造的是原生 `EmbeddingBagCollection`，未接 RecStore | [06 · 其它模型](/ch06/model-examples) |
| tiering 新开关 | `docs/storage/tiered_storage_foundation.md` 只写 “Online admission remains disabled by default”，schema 的 `tiering` 是 `additionalProperties: true` | `dram_keys_path` / `online_admission` / `async_admission` 已生效但既无文档也无约束；`LocalShmParameterServer::ExtraResultFields()` 无调用方 | [05 · 分层策略](/ch05/tiering) |

## 怎么用这张表

- **改代码前**：如果上游文档和这里冲突，以这里为准；这里每条都核过代码。
- **写文档时**：不要照抄 `docs/`，尤其是配置表和 proto 结构。
- **看到可疑结论**：先去[未确认清单](/quality/unknowns)看它是不是“需要实测”的那一类。

上游文档并非全都过时，`docs/config.md` 的字段参考大部分仍然准确；
不一致集中在传输、分层与基准这三块——恰好是改动最频繁的地方。

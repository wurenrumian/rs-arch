---
title: 第 5 块：响应模式
description: 读请求在服务端有两个出口，由描述符里的一组 flag 决定，不是两套协议。
outline: [2, 3]
---

## 它是什么

读请求在服务端有两个出口，由描述符里的一组 flag 决定，不是两套协议。第一个出口把 KV 值区里的真实行地址直接填进 SGE，用一次 scatter 写把多行发回客户端，缺失行用零区补；第二个出口先把行拷进服务端本地 staging，再一次性写回。前者省一次拷贝，但对行的可寻址性有硬要求。

| 维度 | `direct_sg` | `staging_copy` |
| --- | --- | --- |
| 客户端置位 | `kRcFlagGetDirectSg \| kRcFlagGetAllowFallbackCopy` | 无 flag |
| 服务端入口 | `HandleGetDirectSg` → `CachePS::GetParameterDirectFixedRows` | `CachePS::GetParameterFlat` |
| payload 来源 | KV value 区里的原始行指针 + 只读零区（miss 行） | 先拷进服务端 response staging slot |
| 传输形态 | 多条 `WriteSg`，每条最多 32 个 SGE（`kMaxDirectSgesPerWr`） | 单次 `Write`，长度 `response_bytes` |
| 完成 | `CompleteResponseStatusOnly`（只写 StatusWord） | `CompleteResponse`（payload + StatusWord） |
| 失败语义 | 任何一行不可直接寻址 → 整批 abort | 不会 abort |
| 额外注册 | 服务端需要 KV value 区 MR + 零区 MR | 不需要 |

`HandleGetDirectSg` 的硬前置条件（都在代码里检查）：

1. `descriptor.response_bytes == key_count * embedding_dim * 4`，且 `embedding_dim != 0`；
2. `GetParameterDirectFixedRows` 返回 true 且行数吻合；
3. 每一行要么 `missing`（用零区），要么 `data != nullptr && size == row_bytes`；SSD 行或容量不匹配的行会返回 false，整批回退，绝不零填一个存在的 key；
4. 存储侧还要求 `default_value_size_hint == row_bytes`（`KVEngineComposite::BatchGetDirectFixedRows`），且 value store 实现了 `GetDirectFixedRows`（只有 `DRAM_VALUE_STORE` 实现；`hybrid_value_store.h` 只转发了 `RDMABackingData`，默认实现返回 false）。

## 它为什么存在

训练侧读的是连续的行，绝大多数情况下这些行就在同一块值区里，可以直接按地址发走。为此付出的代价是上面四条前置条件与一个整批回退语义：只要有一行不能直接寻址，就整批改走拷贝，绝不把存在的 key 填成 0。

## 它和谁接

上游是[第 3 块](./get)的读路径分支，下游是[第 05 章](../ch05/)的存储接口。会话式协议里没有「关掉回退」的开关：`FillGetDescriptor` 在 `direct_sg` 模式下总是同时置两个 flag，全仓没有只置前者的调用点。因此允许回退这一位恒为真，只在服务端逻辑上有意义。

## 代码位置

`auto` 只活在工具层：旧文档曾把它写成运行时可选项，现在 `docs/parameter_server/rdma.md` 已澄清，只剩配置表一栏仍列着它。

- 二进制里的 flag 是 `DEFINE_string(rdma_get_response_mode, "direct_sg")`（`petps_client.cc`），取值只允许 `direct_sg` 或 `staging_copy`，其他值 `LOG(FATAL)`（`FillGetDescriptor`）。
- 环境变量入口 `RECSTORE_RDMA_GET_RESPONSE_MODE` 也明确拒绝其他值：`ApplyRdmaFlagsFromEnv` 抛 `RECSTORE_RDMA_GET_RESPONSE_MODE must be direct_sg or staging_copy`。
- `auto` 只出现在 `tools/benchmarks/run_benchmark_ps.py#resolve_rdma_get_response_mode`：它在构造命令行之前把 `auto` 解析成 `staging_copy`（当 `index_type == "DRAM_PET_HASH"`）或 `direct_sg`（其他），再以 `--rdma_get_response_mode=...` 传给二进制。
- `model_zoo/rs_demo/cli.py` 走另一条路：直接设 `RECSTORE_RDMA_GET_RESPONSE_MODE = staging_copy if index_type == DRAM_PET_HASH else direct_sg`，同样没有 `auto`。

工具层为什么把 `DRAM_PET_HASH` 映射到 `staging_copy`：代码里没有注释解释。一种与现状自洽的解读是，`DRAM_PET_HASH` 是唯一会被 `SSD_VALUE_STORE` / `TIERED_VALUE_STORE` 复用的 index type（见 `tools/benchmarks/batch_test/storage_runner.py`、`run_kvengine_compare.py` 的矩阵），而这两种 value store 不支持直接行寻址，选 `direct_sg` 会让每批都 abort 再回退。此解释未确认，需要 benchmark 或作者说明。

## 交付一句

响应模式到此交代完毕：同一个分支的两个出口、四条前置条件、一个只在工具层存在的 `auto`。下一块接[第 6 块](./control-plane)，讲让两端相信「处在同一次部署」的那套控制面。

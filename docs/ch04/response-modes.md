---
title: 第 5 块：响应模式
description: 读请求在服务端有两个出口，按描述符里的一组标志位挑一个，不是两套协议。
outline: [2, 3]
---

这一页回答一个问题：读请求处理完了，结果怎么回到客户端。答案只有两个出口，一个直接把行的地址发出去，一个先把行拷到服务端缓冲区再发。看懂这个分界，你就能判断一条读走了哪条路，也明白那个自动选项为什么在运行时无效。

## 它是什么

读请求在服务端有两个出口，同一个请求按描述符里的一组标志位挑一个，不是两套协议。

**出口一：直接寻址。** 服务端有每一行的真实地址，就把地址填进一次分散写，一趟把多行搬到客户端响应槽位。缺失的 key 从预先注册的零区取等长的零补上。省一次拷贝，代价是每行都得能直接寻址。

**出口二：先拷贝。** 服务端不假设行还在原地，先把每行拷进本地响应缓冲区，排成连续一段，再整块写回。

| 维度 | `direct_sg` | `staging_copy` |
| --- | --- | --- |
| 客户端置位 | `kRcFlagGetDirectSg \| kRcFlagGetAllowFallbackCopy` | 无 flag |
| 服务端入口 | `HandleGetDirectSg` → `CachePS::GetParameterDirectFixedRows` | `CachePS::GetParameterFlat` |
| 载荷来源 | KV value 区里的原始行指针 + 只读零区（miss 行） | 先拷进服务端暂存槽位 |
| 传输形态 | 多条 `WriteSg`，每条最多 32 个 SGE（`kMaxDirectSgesPerWr`） | 单次 `Write`，长度 `response_bytes` |
| 完成 | `CompleteResponseStatusOnly`（只写 StatusWord） | `CompleteResponse`（载荷 + StatusWord） |
| 失败语义 | 任何一行不可直接寻址 → 整批 abort | 不会 abort |
| 额外注册 | 服务端需要 KV value 区 MR + 零区 MR | 不需要 |

直接寻址要过四道检查，任何一道不过就整批改走拷贝。

1. 长度要对得上。响应字节数必须正好等于 key 数乘每行字节数（每行是维度乘 4），维度不能是 0。这条挡住行数对、行宽不对的请求。
2. 取行要成功，数量还得吻合。存储层一次取回全部行，返回行数等于 key 数。这条挡住半途缺行。
3. 每行要么缺失，要么可寻址。缺失的 key 用零区补；存在的 key 必须给得出指针且长度正好一行。SSD 上的行或容量不匹配的行判失败，整批回退，绝不零填一个存在的 key。
4. 存储侧还得对得上。组合引擎要求默认行长度等于本行字节数，底层 value store 也要真实现了直接取行：只有 DRAM 那份实现了，混合 store 只转发后备数据指针，默认实现返回 false。

回退是整批的：只要一行不能直接寻址，整批改走拷贝，绝不把存在的 key 填成 0。

## 它为什么存在

训练侧读的是连续的行，多数就在同一块值区里，可以直接按地址发走。代价是上面四条前置条件与一个整批回退。

## 它和谁接

上游是[第 3 块](./get)的读路径分支，下游是[第 05 章](../ch05/)的存储接口。会话式协议里没有「关掉回退」的开关：直接寻址模式下客户端总是同时置两个标志位，全仓没有只置前一个的调用点。所以允许回退这一位恒为真，只在服务端逻辑上有意义。

## 代码位置

### `auto` 只活在工具层

运行时不存在 `auto`。二进制里只有一个二选一的开关，默认直接寻址；写成别的值直接 `LOG(FATAL)` 退出。环境变量入口同样只认这两个取值，其他值当场抛错。

`auto` 只出现在基准脚本里：拼命令行之前先把它解析成具体取值（索引类型是 `DRAM_PET_HASH` 时选先拷贝，其他选直接寻址），再把结果传给二进制。演示 CLI 走另一条路，同样直接给出两个取值之一，没有 `auto`。

旧文档曾把它写成运行时可选项，现在 `docs/parameter_server/rdma.md` 已澄清，只剩配置表一栏仍列着它。

- 二进制里的 flag 是 `DEFINE_string(rdma_get_response_mode, "direct_sg")`（`petps_client.cc`），取值只允许 `direct_sg` 或 `staging_copy`，其他值 `LOG(FATAL)`（`FillGetDescriptor`）。
- 环境变量入口 `RECSTORE_RDMA_GET_RESPONSE_MODE` 也明确拒绝其他值：`ApplyRdmaFlagsFromEnv` 抛 `RECSTORE_RDMA_GET_RESPONSE_MODE must be direct_sg or staging_copy`。
- `auto` 只出现在 `tools/benchmarks/run_benchmark_ps.py#resolve_rdma_get_response_mode`：它在构造命令行之前把 `auto` 解析成 `staging_copy`（当 `index_type == "DRAM_PET_HASH"`）或 `direct_sg`（其他），再以 `--rdma_get_response_mode=...` 传给二进制。
- `model_zoo/rs_demo/cli.py` 走另一条路：直接设 `RECSTORE_RDMA_GET_RESPONSE_MODE = staging_copy if index_type == DRAM_PET_HASH else direct_sg`，同样没有 `auto`。
- 前置条件 1：入口判据是 `descriptor.response_bytes == key_count * embedding_dim * 4`，且 `embedding_dim != 0`。
- 前置条件 4 的两层检查在 `KVEngineComposite::BatchGetDirectFixedRows`（`default_value_size_hint == row_bytes`）与 value store 的 `GetDirectFixedRows`（默认实现返回 false，只有 `DRAM_VALUE_STORE` 实现；`hybrid_value_store.h` 只转发了 `RDMABackingData`）。
- 直接寻址的取行与失败判定在 `CachePS::GetParameterDirectFixedRows`、`HandleGetDirectSg`（行判据 `data != nullptr && size == row_bytes`，缺失行为 `missing`）。

工具层为什么把 `DRAM_PET_HASH` 映射到 `staging_copy`：代码里没有注释解释。一种与现状自洽的解读是，`DRAM_PET_HASH` 是唯一会被 `SSD_VALUE_STORE` / `TIERED_VALUE_STORE` 复用的 index type（见 `tools/benchmarks/batch_test/storage_runner.py`、`run_kvengine_compare.py` 的矩阵），而这两种 value store 不支持直接行寻址，选 `direct_sg` 会让每批都 abort 再回退。此解释未确认，需要 benchmark 或作者说明。

## 交付一句

响应模式到此交代完毕：同一个分支的两个出口、四条前置条件、一个只在工具层存在的 `auto`。下一块接[第 6 块](./control-plane)，讲让两端相信「处在同一次部署」的那套控制面。

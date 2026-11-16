---
title: 第 1 块：请求形状
description: 一个批量请求只有三样东西：表名、key 数组，以及可选的值或梯度。
outline: [2, 3]
---

## 它是什么

一个批量请求只有三样东西：表名、key 数组、以及可选的值或梯度。表名只在建表和更新时出现，key 是 `uint64`，值和梯度是二维 float。Get 的输出允许以 `{0, dim}` 的形式占位，由后端就地把形状补全。key 数组三条传输都当原始字节传，不走 protobuf 的 `repeated` 编码。

值在 wire 上不是裸 float 行，而是一种压缩块：定长头带上 key 与维度，后面紧跟该行的 float 数据。Put、Update、稀疏提交三个写入口都用这个形状，接收端因此只需要一套解释逻辑。

Update 在压缩块之外还带一个客户端学习率（`UpdateParameterRequest.learning_rate`，`0` 表示不上报）。服务端拿它和本地优化器的学习率比对，不一致就拒绝这批更新，所以"客户端乘一次、服务端再乘一次"这类混用会在服务端显式失败，而不是静默算错。

稀疏更新的载荷在压缩块之上又多一层：56 字节定长头描述会话、步号、rank 与分块信息，后面才是行。这个头是唯一做完整范围校验的载荷头，字段越界在解码阶段就抛错。

## 它为什么存在

三种载荷形状对应三种写入语义：整行覆盖、按批更新、按 step 聚合。统一成压缩块，让三条传输共用同一套打包与校验代码。稀疏更新必须把语义放进头里，因为它要跨 rank 去重、按 step 排序，这些信息无法从行数据本身推出来。

表配置单独走一次建表请求，是因为行数和维度决定服务端怎么分配存储，也决定客户端后续能否按 `{0, dim}` 占位。同名表重复建表时服务端比对配置，一致才复用，不一致直接拒绝。

## 它和谁接

上游是计算层交来的张量与表配置（[第 02 章](../ch02/)）。下游是[第 3 块](./protocol)的命令编码：压缩块要么进 proto 字段，要么进 bRPC 的 attachment；56 字节头则进 `payload` 字段。张量形状的合法性在这里就被拒掉，不会拖到服务端。

## 代码位置

| 结构 | 位置与要点 |
| --- | --- |
| 压缩块与打包 | `src/ps/base/parameters.h#ParameterCompressItem`：`#pragma pack(1)` 的 `{uint64_t key; int dim; float embedding[0];}`，wire 上就是定长头加紧随其后的 `dim * 4` 字节 float 行，缺失行用 `dim == 0` 的 item 占位；`src/ps/base/parameters.cpp#Pack<ParameterCompressItem>::CompressAppend` 生成 block，接收端用 `reinterpret_cast<const ParameterCompressReader*>` 直接解释，读取前必须 `Valid(payload_size)` |
| 表配置 | `src/ps/base/base_client.h#EmbeddingTableConfig`：`{num_embeddings, embedding_dim, table_id}`，`Serialize()` 为 JSON；`CachePS::InitTable` 对同名表比对配置，完全一致则复用，不一致返回 -1 |
| 稀疏头 | `src/ps/base/sparse_gradient_commit.h#SparseGradientCommitHeader`：56 字节，静态断言保证；`kind` 为 0 submit / 1 query / 2 close / 3 abort；`version` 只接受 1 或 4；payload 总长必须严格等于 `sizeof(h) + rows * (8 + dim*4)` |
| 形状校验 | `src/ps/base/base_client.h#IsFloatEmbeddingValues`：value/grad 必须是 `FLOAT32` 二维 `[num_keys, dim]` 且 `dim > 0`；gRPC/bRPC 客户端在入口直接拒绝，local_shm 的 `GetParameterFlat` 校验 `keys.Size() == num_rows` |

## 交付一句

请求的形状到此交代完毕：三样入参、两种载荷头、一套形状校验。下一块讲这个请求由谁发出，也就是客户端栈的层次与选型规则。

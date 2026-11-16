---
title: 第 3 块：协议与命令
description: 两份协议文件的消息体几乎逐字相同，差别在命名空间、生成方式与命令枚举。
outline: [2, 3]
---

## 它是什么

两份协议文件的消息体几乎逐字相同：同样的 Get/Put/Update/InitTable/SparseGradientCommit 五个数据通道，同样的 Command 控制通道。差别在命名空间、生成方式，以及命令枚举少两个值。gRPC 一侧用 `service` 声明生成 stub；bRPC 一侧额外声明 `option cc_generic_services = true`，以生成 `ParameterService_Stub`。

Get 与 Put 的载荷在 bRPC 上不走 protobuf 的 `bytes` 字段，而走 attachment：请求 attachment 装 key，响应 attachment 装压缩块。大消息因此绕过一次 protobuf 拷贝，代价是两边读写代码都要先试 attachment、再退回字段。

## 它为什么存在

协议是能力边界的物理位置：客户端能不能做某件事，先看枚举里有没有那个值。两份协议各自独立演化，就必然出现能力不对齐，这类缺失必须写在文档里才可见。

## 它和谁接

上游是[第 2 块](./client-stack)选定的单分片客户端，它按协议编码；下游是两个服务端实现，它们解码后统一交给 PS 核心。Command 通道不经过分片层，由接口直接下发。

## 代码位置

| 命令 / RPC | 语义 | gRPC | bRPC |
| --- | --- | --- | --- |
| `GetParameter` | 按 key 取行，返回压缩块；缺失行以 `dim == 0` 占位 | 支持 | 支持（attachment 优先） |
| `PutParameter` | 整行覆盖；响应里的 `sucess`（proto 拼写如此）两个服务端都不设置，客户端只看 RPC 状态 | 支持 | 支持 |
| `UpdateParameter` | 按表更新梯度；结果由 `CachePS::UpdateParameter` 决定：优化器没初始化、学习率与客户端上报值不一致、按步更新越界都会让它返回 false | 支持 | 支持（梯度走 attachment） |
| `InitEmbeddingTable` | 建表，返回非负 tag；`config_payload` 是 JSON | 支持 | 支持 |
| `SparseGradientCommit` | 提交 56B 头 + 行；失败原因放 `response.error` | 支持 | 支持 |
| `Command(CLEAR_PS / RELOAD_PS / LOAD_FAKE_DATA / DUMP_FAKE_DATA)` | 清空、重载、灌/取假数据 | 支持 | 支持 |
| `Command(SAVE_CHECKPOINT / LOAD_CHECKPOINT)` | `arg1` 路径、`arg2` metadata JSON | 支持 | **协议无此枚举** |

五条语义差异值得单独记住：

- bRPC 的命令枚举只有 `CLEAR_PS=0, RELOAD_PS=1, LOAD_FAKE_DATA=2, DUMP_FAKE_DATA=3`（`src/ps/proto/ps_brpc.proto#PSCommand`）。这是协议级能力缺失，不是客户端忘了调用。
- 两个服务端的 `Command` 都以 `else { LOG(FATAL) << "invalid command"; }` 收尾，枚举外的值会让服务端进程终止。
- gRPC 的 `SparseGradientCommit` 即使业务失败也返回 `Status::OK`，原因在 `response.error`；客户端检查后抛异常。
- `GetParameterRequest.perf` 只用于打点；`model_name`、`GetParameterResponse.keys` 在生产路径没有消费者。
- 协议本身没有批量上限，上限在客户端常量与配置里：gRPC 2000 key（`MAX_PARAMETER_BATCH`）、bRPC 65536（`MAX_PARAMETER_BATCH_BRPC`）、分片层按 `distributed_client.max_keys_per_request`（默认 500）二次切块；旧的 `cache_ps.max_batch_keys_size` 已被服务端 WARNING 后忽略。
- 学习率是"客户端声明、服务端裁决"：`CachePS::CheckLearningRate` 在客户端上报值或服务端学习率任一 ≤ 0 时放行，否则要求两者差值在 `1e-6 * |server_lr|` 内；不匹配打 `ERROR` 并让整批 `UpdateParameter` 失败。

## 交付一句

协议与命令到此交代完毕：五个数据通道、一套控制枚举、以及一处协议级的能力缺失。下一块讲命令发出之前，请求怎么被分到各 shard。

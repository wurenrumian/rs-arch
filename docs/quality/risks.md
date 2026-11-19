---
title: 风险总表
description: 15 条按影响面排序的已知风险：静默失败、无幂等重试、名不副实的持久化。
outline: [2]
---

# 风险总表

跨七章汇总的风险，按**影响面**排序：越靠前，越容易在没人察觉的情况下产出错误结果。
每条都指向讲它的那一块；那里有触发条件和代码位置。

| # | 风险 | 后果 | 详见 |
|---|---|---|---|
| 1 | bRPC 把空 payload 当“整批无行” | 对端截断或连错 PS 时静默产出全 0 行；gRPC 已修 | [03 · bRPC](/ch03/brpc) |
| 2 | 两条更新语义只在进程内 + 服务端 `lr` 校验两道防线 | 未上报 `lr`（传 0）的调用方仍可能施加两次或零次 lr | [01 · 写路径](/ch01/write-path)、[02 · 梯度提交](/ch02/write-path) |
| 3 | bRPC 无 checkpoint，只有失败返回 | 调用方必须切 gRPC，否则存不下 | [03 · 一致性](/ch03/consistency) |
| 4 | RDMA `direct_sg` 与原地 SGD 无同步 | 读到半更新行 / 数据竞争 | [04 · 响应模式](/ch04/response-modes) |
| 5 | “共享内存 / 持久内存”名不副实，slab 池会删同路径文件 | 重启即丢；误指 checkpoint 文件会被清空 | [05 · 写路径与退役](/ch05/write-path) |
| 6 | `EmbRead` 对未知 / 越界 key 静默返回 0 | 训练数据错误但无异常 | [02 · 读路径](/ch02/read-path) |
| 7 | gRPC 单分片并发调用共享 `stubs_[0]` 与同一完成队列 | 多线程读同一分片会互相取走完成事件 | [03 · gRPC 路径](/ch03/grpc) |
| 8 | bRPC 更新重试没有幂等键 | `max_retry` 可能把同一批梯度应用两次 | [03 · bRPC 路径](/ch03/brpc) |
| 9 | local_shm 的 epoch 从不比较、槽位释放队列与获取队列不一致 | 重启后旧映射不被拒绝；多 ready queue 下可能饥饿 | [03 · local_shm](/ch03/local-shm) |
| 10 | 测试注册守卫有盲区 | `src/test/model_zoo/` 与 `src/test/scripts/` 不检查，文本匹配只看名字 | [06 · 测试地图](/ch06/test-map) |
| 11 | `--save-checkpoint` CLI 分支引用不存在的 `checkpoint.py` | 该入口不可用，只能走 `KVClient.save_checkpoint` | [06 · 工程工具](/ch06/tooling) |
| 12 | 配置读取失败被吞成默认值；schema 的 `ps_type` 只列 GRPC/BRPC | 配错不报错；RDMA/LOCAL_SHM 过不了 schema 校验 | [01 · 配置与开关](/ch01/config)、[03 · 配置](/ch03/config) |
| 13 | GPU cache profile 恒为 0 | 基准把“没采集”误读成“没 miss” | [02 · BagPipe](/ch02/bagpipe) |
| 14 | CLOCK 默认保留 SSD 副本、无 RDMA backing、淘汰是分片内单锁 | SSD 要按全量规划；零拷贝读不可用；热分片晋升可能反复失败 | [05 · 分层策略](/ch05/tiering) |
| 15 | 在线准入把读路径换成全拷贝，前台写会让在准备的交换整批作废 | flat / 裸指针快路收益消失；写入密集时晋升实际不发生，只留计数 | [05 · 分层策略](/ch05/tiering) |

## 前五条怎么防

排在前面的五条不是“代码丑”，而是**失败得没有声音**。对应的观测手段：

1. **空 payload**：读请求返回的行数要校验。gRPC 已经这么做了（行数不符返回 `-1`），bRPC 还是老的“空即无行”。
2. **学习率**：客户端与服务端各拿一份 `lr`，不一致就整批拒绝；但传 0 的调用方绕过了这道防线。
3. **checkpoint**：需要在 bRPC 上存盘时，先换传输，不要指望重试。
4. **RDMA 读到半更新行**：要么接受数据竞争，要么在调度上保证同一 key 不并发读写——代码不替你保证。
5. **持久化**：把 `DRAM` 介质当成“重启还在”是这套系统里最容易犯的错。

已修掉的类似问题收在[已修复记录](/quality/fixes)里；还没验证的推断在[未确认清单](/quality/unknowns)。

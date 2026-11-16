---
title: 已修复记录
description: 四个提交区间里修掉的静默失败与结构性缺陷，以及它们现在是什么行为。
outline: [2]
---

# 已修复记录

风险表里有一部分问题已经修掉了。这份记录按提交区间分组，保留“以前错在哪、现在什么样”
的对照——读旧代码或旧文档时，这些是最容易踩空的地方。

基线一路走过来是 `5f92ba2a → 6d205e98 → 7c44f83da → f8fde5af4 → 1f340167d`。

## 5f92ba2a → 6d205e98

| 问题 | 现在的行为 | commit |
|---|---|---|
| gRPC 读失败静默补零 | 15 s deadline；传输失败、status 非 OK、空 payload、行数不符都返回 `-1` | `e2efe502` |
| gRPC 预取失败无感知 | 记录首个失败并整批失败；200 ms × 150 轮（30 s）空闲判超时 | `e2efe502` |
| bRPC checkpoint 静默返回 false | 客户端显式 `ERROR`，`Command` 显式 unsupported；协议仍无枚举 | `c77f5461` |
| 单分片忽略 `cache_ps.servers` | 按 shard 解析 host/port，缺失才回退；非法配置 FATAL | `95616eef` |
| `max_batch_keys_size` 无读者 | 标为 deprecated，检测到打 `WARNING` 并忽略 | `5530c44a` |
| 混用两种更新语义静默错算 lr | 同一 `(client, table)` 换模式直接 `RuntimeError` | `f8dc8545` |
| DRAM/SSD 无淘汰、无读提升 | 新增 tiered LRU 读缓存（默认关闭），写穿透 + 并发屏障 | `71da4896` 等 |
| PetKV flush 空实现且静默成功 | 显式拒绝 checkpoint / clear，说明共享内存不持久 | `2af03910` |
| 大量测试未注册、`test_cceh` 未编译 | 新增 `test_registration_consistency` 守卫，CCEH 编入测试并注册 | `942468d9` |
| `torchrec_dlrm` 顶层 import 是死路径 | 改为 `torchrec_kv.EmbeddingBag`，并有 import 测试守护 | `4d134e6b` |

## 6d205e98 → 7c44f83da

| 问题 | 现在的行为 | commit |
|---|---|---|
| tiered 只有 LRU 读缓存，没有冷热交换 | 新增 `clock`（含频率准入、成本感知、后台交换、保留/释放 SSD 副本）与 `adaptive`；句柄在交换期间不变 | `a8c8de32`、`2af143e0`、`d7f9cd9d` |
| SSD 批量读写逐页提交，同页重复读不合并 | 连续页段合并、批内/跨批页去重、同页写补丁合并；完成收割可配自旋 | `01e5176f`、`c5155aaf` |
| 混合层 SGD 改在 SSD 临时拷贝上，改动丢失 | `ApplySgdMixedRows` 聚合重复 key 并显式写回 SSD；普通 `SGD::Update` 也改走 `UpdateFlat` | `c5155aaf` |
| DRAM 水位判断可被多线程同时通过 | `TryAllocDram` 按实际槽容量 CAS 预留，超限回退释放 | `c5155aaf` |
| PetHash 删除不持 chunk 锁 | 删除沿探测链逐 chunk 加锁，迁移中重试 | `01af2ef7` |
| 客户端学习率跨进程不可见 | 三份 wire 格式各带 `learning_rate`，服务端不一致即拒绝 | `606d86f5`、`8a63bfed` |
| `report()` 只有硬编码的上报通道 | 顶层 `observability` 选 sink，环境变量可覆盖；`test_report` 不再限定 Debug | `0d4247de` |
| tiered 没有 cache-on/off 开关，也没有扫描脚本 | `rs_demo --tiered-cache-policy {LRU,none}`、`run_tiered_cache_sweep.py`、`docs/performance/tiered-e2e.md` 基线 | `e7ca11c5`、`a8c8de32` |
| 文档坏链只在部署时暴露 | 新增 `doc-check` workflow，PR 触及文档即 `mkdocs build --strict` | `4ccead0c` |

## 7c44f83da → f8fde5af4

| 问题 | 现在的行为 | commit |
|---|---|---|
| `tiering.online_admission` 只有名单与 `PrepareExchange`，引擎从不调用 | 引擎接入二次未命中准入、ghost 集合、同步/异步交换、世代失效与后台失败传播 | `cb296098`、`f9d98eef` |
| SSD 没有写计数，写放大不可见 | `IOBackend` 记 `page_writes` / `bytes_written`，两个 SSD 值存储补 payload 字节 | `8edd10be` |
| 静态布局批量写按行、按副本各整页读改写 | 补丁按页合并，一页一次 RMW | `2c107b30` |
| 名单只能手搓，文本 query log 不能回放 | `build_tiered_dram_profile.py`（含 ctest 单测）、`benchmark_kv_engine --read_trace_path` | `cb296098` |

## f8fde5af4 → 1f340167d

| 问题 | 现在的行为 | commit |
|---|---|---|
| `rs_demo` 的 tiered 默认是 LRU 读缓存，用 CLOCK 主放置只能手写 | `--tiered-cache-policy` 接受 `LRU` / `none` / `clock`，`rs_demo` 默认 `clock`；`benchmark/server.py` 模板默认改为 `none` | `571c6d51`、`e6a0f4a8` |
| Python 侧没有上报入口，`KVClient` 自己写死 `build/lib/libreport.so` | 新增 `recstore.telemetry`（ctypes 调 `report()`），与 C++ 共用 sink，缺库时静默降级 | `9691f88d` |
| 端到端每一步的指标只在 CSV 里，观测后端拿不到 | `rs_demo --report-metrics` 发 `e2e_step` 表（13 列），终局 loss 读回后补发 | `0133f3ba`、`f59d2dfd` |
| 多 rank 共用 CSV / JSONL 时可能写出交错行 | 共享 sink 按行加锁，保证行原子 | `db92eb1a` |

---

“已修”不等于“可以依赖”。比如 bRPC 的 checkpoint 现在是**显式失败**，
比静默返回 `false` 好，但没有回退路径这件事没变。这类取舍在
[风险总表](/quality/risks)里仍然列着。

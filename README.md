---
tags: [architecture, index]
---

# RecStore 架构讲解

# 一句话

RecStore 把推荐模型的稀疏 embedding 表放到训练进程之外：Python 侧经 `torch.ops.recstore_ops`
调用进程内单例 `KVClientOp`，按 `cache_ps.ps_type` 构造 gRPC / bRPC / RDMA / local_shm 分片客户端，
把按 key 哈希切分的请求发到参数服务器进程；服务端 `CachePS` 通过 `Optimizer` 把读写落到
`BaseKV`（默认 `KVEngineComposite` = DRAM 索引 + DRAM 值存储）。

六章均按上游 `upstream/main 1f340167d` 核对，用 `calm-explain` 组织成“阅读地图 + 分块推进”。
对应代码在 RecStore 仓库（本地 `D:\Project\RecStore`，上游 [RecStore/RecStore](https://github.com/RecStore/RecStore)）；
历史版本、上游增量摘要留在该仓库本地未入库的 `tmp/archive/docs/` 与 `tmp/remote/`。

# 章节导航

| 章 | 文档 | 行数 | 块数 | 覆盖内容 | 优先读者 |
|---|---|---|---|---|---|
| 01 | [系统总览、仓库地图与构建](01-system-overview-and-build.md) | 432 | 6 | 仓库地图、三层调用链、EmbRead/EmbUpdate 端到端、CMake/打包、配置与环境变量 | 所有人 |
| 02 | [计算层：PyTorch 集成、Python 客户端与 BagPipe](02-compute-layer-pytorch.md) | 580 | 7 | op 注册、KVClient/sharded_client/optimizer、torchrec_kv、BagPipe、ps_pipeline | 训练侧、Python 侧 |
| 03 | [参数服务器层：抽象、协议与传输](03-parameter-server-and-transport.md) | 547 | 10 | PS 抽象、客户端工厂、proto、gRPC/bRPC/local_shm、学习率校验、分片与一致性 | PS / 后端 |
| 04 | [RDMA 传输深潜](04-rdma-transport.md) | 523 | 9 | slot 协议、MR 布局、lane 生命周期、控制面、错误分层、direct_sg | 传输 / 性能 |
| 05 | [存储与内存层](05-storage-and-memory.md) | 628 | 9 | KV 组合矩阵、索引、值存储、分配器、四种 tiering 策略与在线准入、SSD/NVM/GPU | 存储 / 内存 |
| 06 | [模型接入、测试、基准与工具](06-model-zoo-testing-and-tooling.md) | 521 | 6 | rs_demo 接入、model zoo、测试地图、基准地图、改动→验证、文档门禁 | 集成 / 测试 / 运维 |

总量 3231 行。每章开头是阅读地图（一句话、部件表、关系、≤7 行概念表、建议读法），
然后按块五段式展开，末尾有与相邻章节的接口、风险与证据索引。

# 推荐阅读路线

1. **新人 1 天**：01（仓库地图 + 端到端）→ 02 的「读路径」→ 03 的「客户端栈与选型」→ 05 的「组合矩阵」。
2. **改传输/性能**：03 的协议与分片 → 04 全文 → 06 的「改动 → 验证路径」。
3. **改存储**：05 的 GET/写路径 → 05 的第 7 块（`none` / `lru` / `clock` / `adaptive`）→ 05/06 的存储测试与基准。
4. **接模型/调训练**：02 的读/写路径 → 02 的 BagPipe → 06 的 rs_demo 接入。

# 六章共同确认的核心事实

1. **调用链**：`RecStoreClient`/`KVClient` → `torch.ops.recstore_ops` → `KVClientOp`
   （进程内单例）→ `CreatePSClient`（`PSClientType`：`kGrpc`/`kBrpc`/`kRdma`/`kLocalShm`）→
   `ShardClient` → 服务端 `CachePS` → `BaseKV`/`KVEngineComposite`。
2. **默认存储组合**：`DRAM_PET_HASH` 索引 + `DRAM_VALUE_STORE` 值存储 +
   `CONCURRENT_SLAB_MEMORY_POOL` 分配器；SSD/NVM/tiered 是可选路径，不是默认。
3. **key 空间**：逻辑 key = `(id, tag)`，`tag` 拼在 key 高 8 位；分片是
   `hash(key) % num_shards`，每个分片由独立服务进程里的一个 `CachePS` 独占。
4. **学习率现在跨进程可见**：`update_async` / `local_update_flat` / `emb_update_table` 把客户端
   `lr` 随请求送到 PS（proto `learning_rate`、local_shm 槽位头、RDMA descriptor 各有一份），
   `CachePS::CheckLearningRate` 与优化器不一致时拒绝整批更新；`DistEmbedding` 仍是客户端
   pull-modify-push，进程内同一 `(client, table)` 换模式由 `_record_table_update_mode` 抛错。
5. **四类传输**：gRPC、bRPC、RDMA、local_shm。RDMA 的 GET 有 `direct_sg` / `staging_copy` 两种
   响应模式；`auto` 只存在于工具层（`run_benchmark_ps.py`、`rs_demo/cli.py`），二进制不接受。
6. **BagPipe 生产路径是 planned controller**：参数由 PS 拥有，GPU 上是有界缓存 + 淘汰；
   `read_mode=bagpipe` 不会自动启用 C++ GPU cache，TTL/`controller.py` 那套只在单测与显式
   `enable_gpu_cache()` 路径生效。
7. **tiered 有四种策略**：`none`（按水位一次性安放）、`lru`（预扣预算的 SSD 读缓存）、
   `clock`（DRAM/SSD 按热度交换，含可选异步回写，失去零拷贝与 RDMA backing）、
   `adaptive`（按 `expected_dram_bytes` 自选）。库与 benchmark server 模板默认 `none`，
   `rs_demo` 的 tiered 配置默认 `clock`。
   另有与策略正交的 `dram_keys_path`（历史热度名单）与 `online_admission`（二次未命中在线换位，
   要求版本 `f8fde5af4` 起的引擎侧接线；打开后读路径全拷贝）。
8. **存储默认不持久**：`ShmFile::ConfigForMedium("DRAM")` 实为匿名 `mmap`；PetKV 显式拒绝
   checkpoint 与 clear；只有 `clock` 会在运行期搬动已有行。
9. **bRPC 没有 checkpoint**：协议缺 `SAVE/LOAD_CHECKPOINT`，客户端显式打 `ERROR` 返回
   `false`，不再静默失败，但也没有回退路径。
10. **观测通道可配**：`report()` 的 sink 由顶层 `observability`（`remote`/`csv`/`jsonl`/`glog`/`none`）
    选择，旧 `report_API` 仅作兼容；`USE_PERF_REPORT` 不再限定 Debug 构建。

# 优先关注的风险（按影响面排序）

| # | 风险 | 后果 | 详见 |
|---|---|---|---|
| 1 | bRPC 把空 payload 当“整批无行” | 对端截断或连错 PS 时静默产出全 0 行；gRPC 已修 | 03 |
| 2 | 两条更新语义只在进程内 + 服务端 `lr` 校验两道防线 | 未上报 `lr`（传 0）的调用方仍可能施加两次或零次 lr | 01、02 |
| 3 | bRPC 无 checkpoint，只有失败返回 | 调用方必须切 gRPC，否则存不下 | 03、06 |
| 4 | RDMA `direct_sg` 与原地 SGD 无同步 | 读到半更新行 / 数据竞争 | 04 |
| 5 | “共享内存/持久内存”名不副实，slab 池会删同路径文件 | 重启即丢；误指 checkpoint 文件会被清空 | 05 |
| 6 | `EmbRead` 对未知/越界 key 静默返回 0 | 训练数据错误但无异常 | 02 |
| 7 | gRPC 单分片并发调用共享 `stubs_[0]` 与同一完成队列 | 多线程读同一分片会互相取走完成事件 | 03 |
| 8 | bRPC 更新重试没有幂等键 | `max_retry` 可能把同一批梯度应用两次 | 03 |
| 9 | local_shm 的 epoch 从不比较、槽位释放队列与获取队列不一致 | 重启后旧映射不被拒绝；多 ready queue 下可能饥饿 | 03 |
| 10 | 测试注册守卫有盲区 | `src/test/model_zoo/` 与 `src/test/scripts/` 不检查，文本匹配只看名字 | 06 |
| 11 | `--save-checkpoint` CLI 分支引用不存在的 `checkpoint.py` | 该入口不可用，只能走 `KVClient.save_checkpoint` | 06 |
| 12 | 配置读取失败被吞成默认值；schema 的 `ps_type` 只列 GRPC/BRPC | 配错不报错；RDMA/LOCAL_SHM 过不了 schema 校验 | 01、03 |
| 13 | GPU cache profile 恒为 0 | 基准把“没采集”误读成“没 miss” | 02 |
| 14 | CLOCK 默认保留 SSD 副本、无 RDMA backing、淘汰是分片内单锁 | SSD 要按全量规划；零拷贝读不可用；热分片晋升可能反复失败 | 05 |
| 15 | 在线准入（`online_admission`）把读路径换成全拷贝，且前台写会让在准备的交换整批作废 | flat/裸指针快路收益消失；写入密集时晋升实际不发生，只留计数 | 05 |

# 已修复（5f92ba2a → 6d205e98）

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

# 本轮已修复（6d205e98 → 7c44f83da）

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

# 本轮已修复（7c44f83da → f8fde5af4）

| 问题 | 现在的行为 | commit |
|---|---|---|
| `tiering.online_admission` 只有名单与 `PrepareExchange`，引擎从不调用 | 引擎接入二次未命中准入、ghost 集合、同步/异步交换、世代失效与后台失败传播 | `cb296098`、`f9d98eef` |
| SSD 没有写计数，写放大不可见 | `IOBackend` 记 `page_writes` / `bytes_written`，两个 SSD 值存储补 payload 字节 | `8edd10be` |
| 静态布局批量写按行、按副本各整页读改写 | 补丁按页合并，一页一次 RMW | `2c107b30` |
| 名单只能手搓，文本 query log 不能回放 | `build_tiered_dram_profile.py`（含 ctest 单测）、`benchmark_kv_engine --read_trace_path` | `cb296098` |

# 本轮已修复（f8fde5af4 → 1f340167d）

| 问题 | 现在的行为 | commit |
|---|---|---|
| `rs_demo` 的 tiered 默认是 LRU 读缓存，用 CLOCK 主放置只能手写 | `--tiered-cache-policy` 接受 `LRU`/`none`/`clock`，`rs_demo` 默认 `clock`；`benchmark/server.py` 模板默认改为 `none` | `571c6d51`、`e6a0f4a8` |
| Python 侧没有上报入口，`KVClient` 自己写死 `build/lib/libreport.so` | 新增 `recstore.telemetry`（ctypes 调 `report()`），与 C++ 共用 sink，缺库时静默降级 | `9691f88d` |
| 端到端每一步的指标只在 CSV 里，观测后端拿不到 | `rs_demo --report-metrics` 发 `e2e_step` 表（13 列），终局 loss 读回后补发 | `0133f3ba`、`f59d2dfd` |
| 多 rank 共用 CSV / JSONL 时可能写出交错行 | 共享 sink 按行加锁，保证行原子 | `db92eb1a` |

# 文档与代码不一致（仍存在）

| 主题 | 仓库文档说法 | 代码事实 | 详见 |
|---|---|---|---|
| RDMA 注册内存 | `docs/parameter_server/rdma.md` 写“默认 128 MiB” | 结构体默认值如此，RC 路径按 lane 切片覆盖；默认每 lane 2 MiB | 04 |
| RDMA `auto` 响应模式 | 同文配置表仍把 `auto` 列为取值（正文已澄清） | 二进制只接受 `direct_sg` / `staging_copy`；`auto` 在工具层展开 | 04 |
| PS 继承关系 | `docs/parameter_server/grpc.md` 称继承 `BasePSClient`、单个 `stub_` | 实际继承 `ShardClient`，持有 `stubs_` 向量 | 03 |
| bRPC proto | `docs/parameter_server/proto.md` 称两份结构类似 | `PSCommand` 少 `SAVE/LOAD_CHECKPOINT` 两项 | 03 |
| `shard_manager.h` | `docs/parameter_server/base.md` 写作分片管理 | 只被离线 `load_db.h` 使用 | 03 |
| `ps_type` schema | `tools/config/recstore_config.schema.json` enum 只有 GRPC/BRPC | C++ 适配层还接受 RDMA / LOCAL_SHM | 03 |
| 组合矩阵 | `docs/storage/composite_kvengine.md` 把 SSD 索引 × DRAM value 标“不推荐” | 代码不禁止，测试直接 skip；只有构造期字段检查 | 05 |
| `KVClient.wait(handle)` | `docs/api/python.md` 称可只等待 prefetch | 只处理 update 句柄；prefetch 需 `emb_wait_result` | 02 |
| 算子接入示例 | `docs/dev/feature/add_operator.md` 用 `torch.ops.load_library` 与旧签名 | 实际 `torch.classes.load_library` + 多路径发现，签名已变 | 02 |
| e2e 报告字段 | `docs/performance/e2e.md` 说报告 p50 ms/step | 实际输出 `p95_step_total_ms` 与阶段均值 | 06 |
| `distributed_dlrm_training.py` | 文件头注释称接入 RecStore | 构造的是原生 `EmbeddingBagCollection`，未接 RecStore | 06 |
| tiering 新开关 | `docs/storage/tiered_storage_foundation.md` 只写 “Online admission remains disabled by default”，schema 的 `tiering` 是 `additionalProperties: true` | `dram_keys_path` / `online_admission` / `async_admission` 已生效但既无文档也无约束；`LocalShmParameterServer::ExtraResultFields()` 无调用方 | 05 |

# 未确认清单（需要构建、硬件或实测）

- **RDMA**：lane 重建时延包线、`direct_sg` 并发读的实际影响、重建预算是按 lane 终身累计
  （成功后不复位）带来的长期风险、故障注入 4.2–4.4 s 的来源（04 章列 11 项）。
- **构建**：`RECSTORE_ENABLE_THIRD_PARTY_ENGINES=ON` 的可构建性、Windows 支持（01）。
- **存储后端**：SPDK 实际可用性、HPS 外部引擎、`GPUCacheWithNoHash` 的 `start != 0` 语义、
  CLOCK 在真实 trace 下的命中率与回写开销、`completion_poll_spins` 的最优值（05）。
- **在线准入**：`online_admission` 在真实 trace 下的晋升率与 `online_stale_jobs` / `online_queue_drops`
  比例、名单行数与水位的匹配、异步交换对 SGD 停顿时延的影响，均只有单测与上游单机结果（05）。
- **local_shm**：`tid` 语义、多 ready queue 饥饿、`InitEmbeddingTable` 无 deadline（03）。
- **基准**：`perf` 基线只有 `node190-intel-r-xeon-r-gold-5420` 一个桶，其他机器报 `no-baseline`；
  `e2e/custom/runner.py` 以仓库根为 cwd 调 ctest 是否能命中 build 目录；tiered 的端到端基线
  来自上游机器，未在本机复现（06）。

# 生成方式与维护

- 2026-11-07 由 6 个 Orca `opencode2` worker 并行产出初稿；2026-11-08 按 `calm-explain`
  改成“阅读地图 + 分块推进”；2026-11-09 仓库快进到 `6d205e98` 后逐章复核事实并压缩；
  2026-11-11 合并上游 `7c44f83da`（39 个提交）后，按章节涉及面刷新事实与风险表；
  2026-11-13 只读同步上游 `f8fde5af4`（8 个提交）后补 05 的在线准入、SSD 写计数与 06 的基准开关；
  2026-11-16 只读同步 `1f340167d`（12 个提交，PR #372/#377），改 `rs_demo` 默认 `clock`、
  server 模板默认 `none`，补 06 的 `recstore.telemetry` 与测试注册计数。
- 2026-11-16 从 RecStore 仓库的本地 `tmp/docs/memory/architecture/` 移出，成为独立仓库并从此处维护；
  更早的版本与该仓库的上游增量摘要留在 RecStore 本地未入库的 `tmp/archive/docs/`、`tmp/remote/`。
- 规格与任务记录：`../RecStore/tmp/archive/agents/`（历史轮次，未入库）。
- 证据约定：正文用 `相对路径#符号`（类/函数/宏/字段），不引用行号；每章末尾有「证据索引」，
  文件清单在章节附录。
- 代码变动后请按章末证据索引复核，并优先跑第 06 章的「改动 → 验证路径」表。

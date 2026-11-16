---
title: 第 3 块：测试地图
description: 验证网分 C++ 与 Python 两层，按“测试文件对应一组不变量”组织。
outline: [2, 3]
---

## 它是什么

验证网分两层：C++ 侧由测试框架驱动，目标定义在构建文件里；Python 侧以模块为单位，一部分被注册进同一个驱动，其余靠脚本或人工运行。组织原则是"测试文件对应一组不变量"。

怎么用这一块：先跑 `ctest` 三条 lane 判断自动覆盖是否通过；再按改动落点查附录里的测试条目，确认有没有对应的不变量；新增测试则先过注册守卫，再进 lane。

| 入口 | 用途 |
| --- | --- |
| `ctest --test-dir build -LE "python\|rdma_integration"` | 单测 lane（CI 再加 `^perf$`） |
| `ctest --test-dir build -L python` | Python lane |
| `ctest --test-dir build -L rdma_integration` | RDMA 集成 lane，无硬件时 exit 77 |
| `test_registration_consistency` | 新增测试是否注册或豁免的守卫 |

## 它为什么存在

[推断] 这套系统的失效方式很少表现为崩溃，更多是"数值还对但顺序错了"或"路径悄悄退化成慢路径"。所以测试按不变量组织：提交幂等、到达顺序、所有权语义、位精确对齐。

## 它和谁接

向上被 CI 与本地复现脚本调用，向下依赖构建产物与外部条件（CUDA、RDMA 网卡、io_uring、临时目录）。跑不起来的测试大多缺前置条件，问题通常不在逻辑。

### 子块 3.1：注册守卫

`src/test/scripts/check_test_registration.py` 扫描 `src/test/test_*.cpp` 与 `src/python/pytorch/recstore/unittest/test_*.py`。规则：文件名必须出现在任意 `CMakeLists.txt`，否则必须在脚本的 `EXEMPT` 里写明原因。`test_registration_consistency`（`meta;python`）随 python lane 执行，所以**新增测试若既不注册也不豁免，CI 会直接失败**。

存量豁免共 10 条：5 个 pytest-only 模块（`test_gradient_compression`、`test_sparse_sgd_topk_{backend,distributed,integration}`、`test_topk_strict_prevalidation`）、4 个手动 runner（`test_ebc_precision`、`test_ebc_precision_{distributed_runner,multiprocess}`、`test_sparse_sgd_topk_gloo`）、1 个 stale（`test_gpu_training_cache`）。脚本同时把"已注册却仍在豁免表"报为 stale，防止豁免表腐烂。

注意守卫的匹配是文本级的，且范围不含 `src/test/model_zoo/` 与 `src/test/scripts/`：注册与豁免只对上面两个目录生效。

### 子块 3.2：本轮新增与变更

- `test_cceh` 已注册：`CCEH.cpp` 直接编进测试目标，标签 `storage;slow`、600 s、`RUN_SERIAL`。`test_ssd_extendible_hash.cpp` 已删除（引用已不存在的 API）。
- torchrec 依赖的五个 Python 模块（`test_bagpipe_planned`、`test_fused_prefetch`、`test_shared_fused_namespace`、`test_sparse_optimizer_staging`、`test_step_consistency`）合并为一个 ctest 项 `test_recstore_torchrec_py`，只在 `python -c "import torchrec"` 成功时注册；失败时 CMake 打印跳过原因。
- `add_recstore_unittest` 统一设置 `PYTHONPATH=src/python/pytorch`、cwd 为仓库根；`add_python_unittest` 只设 cwd。注册 Python 包内模块时用前者，注册脚本文件时用后者。
- 新增守护测试：`test_petkv_unsupported`（PetKV 的 checkpoint 显式不支持）、`test_shard_endpoint`（单分片监听地址解析）、`test_torchrec_dlrm_imports_py`（import 路径）、`perf_suite_unit_py`（`test_perf_suite`）。
- 本轮（`6d205e98` 之后）增加的覆盖：`test_report` 不再要求 Debug 构建，`USE_PERF_REPORT=ON` 时即可编译，覆盖 sink 选择与环境变量覆盖；`test_ssd_allocators` / `test_io_backend` 扩到批量窗口、页去重、写失败回滚；`test_ssd_static_layout_value_store` 扩到 CLOCK 交换、异步交换、四种策略选择；Python 侧新增 `test_sharded_update_async_lr` 并注册进 `test_recstore_client_py`；`test_server_ports.py` 覆盖 `--tiered-cache-policy` 的注入与非法值拒绝（该目录不在注册守卫范围内，仍未进 ctest）。
- 本轮（`7c44f83da` 之后）增加的覆盖：`test_ssd_static_layout_value_store` 扩到在线准入（`OnlineAdmission*`：回滚、并发写不被覆盖、staging 余量、合并大请求、范围接口回退）与异步准入（`AsyncAdmission*`：陈旧快照、失败传播、只读请求排空），并断言非法重复批次不写任何一行；`test_ssd_allocators` 开始校验 `GetWriteStats()` 的页写与字节；新增 `test_build_tiered_dram_profile_py`（`add_python_unittest`）。
- 本轮（`f8fde5af4` 之后）增加的覆盖：`test_telemetry`（`add_python_unittest`，标签 `python;telemetry`）覆盖 `telemetry.py` 的候选库排序、`RECSTORE_REPORT_LIBRARY` 覆盖与 `emit` 的缺库降级；`test_e2e_metrics`（`add_recstore_unittest`，同标签）覆盖 `--report-metrics` 发出的 `e2e_step` 行（含终局 loss 补发）；`test_report.cpp` 扩 50 行，覆盖 CSV / JSONL sink 的跨进程行原子。

### 子块 3.3：运行方式与标签

```bash
# 单测 lane（CI 用 -LE "python|rdma_integration|^perf$"）
ctest --test-dir build --output-on-failure -LE "python|rdma_integration"
# Python lane
ctest --test-dir build --output-on-failure -L python
# RDMA 集成 lane（无硬件时自动 skip，exit 77）
ctest --test-dir build --output-on-failure -L rdma_integration
# 单点复现
ctest --test-dir build -R test_kvengine --output-on-failure
```

标签族：`python`、`storage`、`storage;slow`、`local_shm`、`rdma_integration`、`ps_integration`、`ps_unit`、`hierkv`、`integration`、`torch_ops`、`hugectr`、`ebc`、`gpu`、`rs_demo`、`optimizer`、`sparse`、`bagpipe`、`torchrec`、`torchrec_kv`、`config`、`meta`、`perf_smoke`。资源属性另有 `RUN_SERIAL`、`RESOURCE_LOCK`（`local_shm_tests`、`gpu_tests`、`perf_smoke`）与 `SKIP_RETURN_CODE 77`。Python 模块手工运行时需要 `PYTHONPATH=src/python/pytorch`（ctest 项已内置）。

## 代码位置

- `src/test/CMakeLists.txt#add_python_unittest`、`#add_recstore_unittest`、`#add_test` — 注册表。
- `src/test/scripts/check_test_registration.py` — 注册守卫与 `EXEMPT`。
- `src/ps/rdma/CMakeLists.txt#add_petps_owner_test` — 多 shard owner 测试族。
- `src/framework/CMakeLists.txt` — `pytorch_client_test*` 的 env 与 `SKIP_RETURN_CODE 77`。
- `src/python/pytorch/recstore/unittest/` — Python 侧全部模块。

## 交付一句

第 3 块到此为止，读者应当知道哪一层测试是自动的、哪一层要手工跑，以及新增测试为什么会被守卫拦住。[第 4 块](./benchmark-map)接基准地图，把这些测试守不住的性能问题交给三层口径。

---
title: 第 2 块：其它模型与例子
description: 三条完整训练路径与一批早期脚本，各自接入 RecStore 的程度差别很大。
outline: [2, 3]
---

## 它是什么

除主入口外，仓库里还有三条完整训练路径和一批早期脚本。接入程度差别很大：有的走自研 embedding 模块，有的只做对照，有的与 RecStore 无关。

## 它为什么存在

对外演示需要"同一份数据、两种后端"的对照，也需要覆盖 TorchRec 与 TensorFlow 两种生态。这带来一个副作用：同名脚本的接入状态不一致，读者容易按文件名的字面意思误判。

## 它和谁接

它们上接各自的训练脚本入口，下接同一套 Python 绑定；共享的是 embedding 模块与稀疏优化器，不共享训练循环。

| 模型 / 例子 | 入口 | 接 RecStore？ | 备注 |
| --- | --- | --- | --- |
| `rs_demo` | `run_mock_stress.py` → `cli.py` | 是 | 主参考实现；三种 backend（RecStore / TorchRec / HPS Torch）都 `lr=0.01` |
| `torchrec_dlrm` custom | `run_single_day.sh` → `tests/dlrm_main_single_day.py` | 是 | `RecStoreEmbeddingBagCollection` + `SparseSGD`，每步 `zero_grad → forward → backward → validate_config → step → flush` |
| `torchrec_dlrm` 对照 | 同上 `--torchrec` → `tests/dlrm_main_torchrec_single.py` | 否 | 原生 `EmbeddingBagCollection` + `DistributedModelParallel` + `EmbeddingShardingPlanner` |
| `torchrec_dlrm/dlrm_main.py` | 直接运行 | 是（import 已修） | 顶层 `from python.pytorch.torchrec_kv.EmbeddingBag import ...`；`run_single_day.sh` 不调用它，`test_torchrec_dlrm_imports_py` 守护 |
| `criteo_kaggle` 全量 | `run_recstore.sh` / `run_torchrec.sh` | 前者是 | 出 val AUC，默认 2 epoch；`recstore_config.json` 两 shard RDMA |
| `criteo_kaggle` 短步 | `bench_compare.py` | 是 | 调 `tools.benchmarks.e2e.custom.cli`，拓扑只来自自己的 `--clients`/`--ps`，不读 `cluster.sh` |
| `tensorflow_dlrm` | `train.py` + `client.py` | 是 | Keras 层里用 `emb_read`/`emb_update` 手写 `tf.custom_gradient`，没有稀疏优化器抽象 |
| `examples/distributed_dlrm_training.py` | `python examples/...` | 否 | 原生 EBC，注释称接入 RecStore，实际没有；`sys.path` 硬编码作者机器路径 |
| `src/executable/*` | `perf_emb.py` 等 | 部分 | 早期性能脚本，依赖 `pyinstrument`/`debugpy`，不在 CI 与基准驱动里 |

`torchrec_kv/` 只提供被复用的 embedding 模块本体（`EmbeddingBag.py`、`EmbeddingCollection.py`、`fused_preload.py`），不含训练循环；`recstore.__init__` 通过 `__getattr__` 懒加载 `RecStoreEmbeddingBagCollection`。TF 侧 `client.py` 默认加载 `build/lib/lib_recstore_tf_ops.so`，路径相对仓库根解析。

## 代码位置

- `model_zoo/torchrec_dlrm/run_single_day.sh` — `CUSTOM_SCRIPT` / `TORCHREC_SCRIPT` 的选择。
- `model_zoo/torchrec_dlrm/tests/dlrm_main_single_day.py`、`#dlrm_main_torchrec_single.py` — 两条对照路径。
- `model_zoo/criteo_kaggle/README.md`、`#bench_compare.py`、`#start_rdma_ps.py` — 两套入口与短步驱动。
- `model_zoo/tensorflow_dlrm/recstore_embedding_layer.py`、`#client.py` — TF 绑定。

## 交付一句

第 2 块到此为止，读者应当知道"目录里有的脚本"与"真正接进来的脚本"不是一回事。[第 3 块](./test-map)接测试地图，说明这些路径各自被什么测试守住。

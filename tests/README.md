# 自动化回归测试目录（`tests/`）

本目录存放开发者与 PR 贡献者使用的自动化回归测试，用于在修改代码或合并 PR 前，检查核心功能是否被意外改坏。

> **普通用户提示**：发给普通用户的正式安装包由 `scripts/package-release.js` 与 `scripts/package-release.py` 按白名单打包，**不会包含 `tests/` 目录**；日常安装或使用本套件时，完全无需关注这里的任何文件。

## 如何运行测试

请在**仓库根目录**下执行以下命令：

- **核心回归套件（Node.js）**：
  ```bash
  npm test
  # 等价于：npm run test:suite
  ```
- **附件扫描测试（Python）**：
  ```bash
  python3 -m unittest discover -s tests -p "*_test.py" -v
  ```

## 目录文件一览

| 文件名 | 测试范围说明 |
| :--- | :--- |
| `meter-core.test.js` | Token 与上下文预算计算、费用与汇率换算、版本号解析及外部链接校验 |
| `meter-renderer.test.js` | 前端面板渲染逻辑、状态展示与基础 XSS 防护 |
| `meter-storage-proxy.test.js` | 本地配置安全读写、调用账本持久化与代理环境检测 |
| `meter-subscription.test.js` | 订阅地区、自定义套餐设置与面板联动 |
| `meter-integration.test.js` | 多地区/币种持久化、多轮同步防回退等跨模块集成回归 |
| `meter-suite-refactor.test.js` | 套件安装器、浮层与核心主流程综合回归 |
| `attachment_scan_test.py` | 附件扫描模块（如表格/文档内容解析与统计）单元测试 |

## 新增测试约定

1. 所有新编写的单元测试或集成测试统一放入 `tests/` 目录。
2. 测试文件引用仓库根目录的源码时，请使用 `../` 相对路径（例如 `require('../meter-core')`）。
3. 提交 PR 前，请务必确认上述 Node.js 与 Python 两套测试命令全部通过。

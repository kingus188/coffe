# 参与 Coffe 贡献

[English](CONTRIBUTING.md) | 中文

Coffe 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立 Fork。贡献必须保留上游署名和许可证声明，详见 [UPSTREAM.md](UPSTREAM.zh.md)。

## Issue 与讨论

在[本仓库 Issues](https://github.com/kingus188/coffe/issues)提交 Coffe 的问题和功能需求，提供提交版本、平台、复现步骤及预期行为。附件中应移除凭据和私人对话内容，使用问题可在 [Discussions](https://github.com/kingus188/coffe/discussions) 讨论。

## Pull Request

常规开发以 `dev` 为目标分支，维护者将已审查的改动从 `dev` 推进到 `main`。每个 Pull Request 保持范围集中，说明行为、验证结果和迁移要求。遵循 [AGENTS.md](AGENTS.md) 和[开发指南](docs/development.zh.md)，代码改动同步更新相关文档与测试。

根据改动涉及的包运行相称检查。PostgreSQL 改动运行真实数据库契约测试，文档改动运行 `pnpm run doc-sync`。Coffe CI 工作流在 GitHub 托管运行器上检查类型、文档和 PostgreSQL 行为，无需模型凭据。

## 上游协作

报告问题时，区分 Coffe 特有行为与继承的实现。向上游贡献前遵循其当前贡献政策。导入改动时保留上游提交历史并记录来源，不得用 Coffe 品牌替换第三方许可证声明。

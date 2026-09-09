# Coffe

[English](README.md) | 中文

**Coffe 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 二次开发、独立维护的开源项目；原项目由 [DeepSeek AI](https://deepseek.com) 开发。** Coffe 沿用其插件化架构，扩展自托管 Agent 运行和 PostgreSQL 会话存储能力。Coffe 不是 DeepSeek 官方发行版。

底层 Harness、Web UI、工具、SDK 和插件架构来源于 DeepSeek Harness，插件框架使用 [Cordis](https://github.com/cordiverse/cordis)。项目来源及维护关系见[上游致谢与维护说明](UPSTREAM.zh.md)。

## Coffe 增加了什么

- PostgreSQL 会话持久化，支持跨进程写入所有权和事务化追加。
- 可查询的消息内容、工具调用关联、Token 计量和全文 SQL 搜索。
- 使用 `coffe` 运行数据库和 `coffe_` 表前缀，支持旧会话表原地迁移。

这些扩展由 [PostgreSQL 后端](packages/session/session-persistence-postgres/README.zh.md)实现。本版本尚不包含多用户权限和完整的运行管理控制台。

## 开发者预览

Coffe 及其上游仍在演进，接口和配置可能变化。运行能够访问文件、执行命令或调用外部服务的 Agent 前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

<a id="run-from-source"></a>

### 从源码运行

使用 Node.js `^22.19.0` 或 `>=24.0.0`，以及 pnpm `11.7.0`：

```sh
git clone https://github.com/kingus188/coffe.git
cd coffe
pnpm install
pnpm run build
pnpm dsh web --no-open
```

Web UI 默认监听 `http://127.0.0.1:3080`。开始对话前请配置模型提供者，详见 [Web UI 指南](docs/user/guide/index.zh.md)。

保留的 `dsh` 命令和 `@deepseek-ai/*` 工作区包名代表继承的接口。`npx @deepseek-ai/dsh` 安装的是上游项目，不是本 Fork。Coffe 尚未发布独立的 npm 包或桌面安装包，请通过本仓库源码运行二开功能。

### PostgreSQL 存储

PostgreSQL 是可选项。需要使用时，挂载 [PostgreSQL 持久化插件](packages/session/session-persistence-postgres/README.zh.md)替代 JSONL，并将连接配置指向你的 `coffe` 数据库。凭据不得进入 Git，已有 JSONL 会话保留在原后端。

## 文档与支持

- 通过 [Coffe Issues](https://github.com/kingus188/coffe/issues)提交可复现的问题和功能需求。
- 通过 [Coffe Discussions](https://github.com/kingus188/coffe/discussions)讨论使用和设计问题。
- [开发指南](docs/development.zh.md)和[架构文档](docs/architecture.zh.md)介绍继承的 Harness 与当前实现。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)提供上游源码、发行版和社区入口。

本仓库文档包含继承的 DeepSeek Harness 资料。其中的上游 npm 包和官方服务说明描述的是上游行为；Coffe 特有的存储与发行说明以本页及所链接的后端 README 为准。

## 参与贡献

Coffe 接受 Issue 和 Pull Request，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。`main` 是公开基线分支，`dev` 是集成开发分支。Agent 贡献者遵循 [AGENTS.md](AGENTS.md)。

## 许可证与致谢

Coffe 使用 [MIT 许可证](LICENSE)，保留原始 `Copyright (c) 2026 DeepSeek` 版权声明和许可正文。上游实现归功于 DeepSeek 及原贡献者，Coffe 的二次开发改动记录在 Git 历史中。

第三方许可证继续保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。

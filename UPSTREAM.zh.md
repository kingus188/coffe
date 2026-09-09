# 上游来源与致谢

[English](UPSTREAM.md) | 中文

**Coffe 来源于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，原项目由 DeepSeek AI 及其贡献者开发。** 本仓库保留上游 Git 历史，由 [kingus188](https://github.com/kingus188) 独立维护，不代表 DeepSeek 官方发行或背书。

## 继承的能力

DeepSeek Harness 提供插件架构、Agent 循环、会话模型、Web UI、工具集成和 SDK 基础，[Cordis](https://github.com/cordiverse/cordis) 提供底层插件框架。这些贡献的署名归原作者所有。

## Coffe 维护的内容

Coffe 维护 PostgreSQL 持久化扩展、`coffe_` 运行表及其迁移，以及本 Fork 的仓库与贡献流程。[README.md](README.zh.md) 描述已提供的扩展，尚未实现的产品设想不作为发行能力宣传。

内部 `@deepseek-ai/*` 包名和 `dsh` 命令为源码兼容和上游维护而保留，不表示 Coffe 会向 DeepSeek 命名空间发布包。继承文档中的上游安装命令、发布地址和桌面应用身份不属于 Coffe 的发行渠道，请使用本仓库说明的源码安装方式。

## 同步方式

`origin` 指向 `kingus188/coffe`，`upstream` 指向 `deepseek-ai/deepseek-harness`。按需通过 Git 获取并合并上游改动，同步不依赖 GitHub Fork 关联。将审查过的上游改动导入 `dev`，验证合并后的改动，再推进到 `main`。保留原始提交，将 Coffe 扩展组织为范围集中的提交，使来源和后续合并可审查。此流程仅将上游分支和标签作为只读输入。

## 许可证

完整保留原始 [MIT 许可证](LICENSE)，包括 `Copyright (c) 2026 DeepSeek`。复制与分发时应保留该声明及适用的[第三方许可证信息](THIRD_PARTY_NOTICES.md)。上游引用、历史 Issue 链接和第三方来源继续标注其所属项目。

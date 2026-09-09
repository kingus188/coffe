# Contributing to Coffe

English | [中文](CONTRIBUTING.zh.md)

Coffe is an independent fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Contributions must preserve upstream attribution and license notices. See [UPSTREAM.md](UPSTREAM.md).

## Issues and discussions

Report Coffe bugs and feature requests in [this repository's Issues](https://github.com/kingus188/coffe/issues). Include the commit, platform, reproduction steps, and expected behavior. Remove credentials and private conversation content from attachments. Use [Discussions](https://github.com/kingus188/coffe/discussions) for usage questions.

## Pull requests

Target `dev` for ordinary development. Maintainers promote reviewed changes from `dev` to `main`. Keep each pull request focused and describe its behavior, verification, and any migration requirements. Follow [AGENTS.md](AGENTS.md) and the [development guide](docs/development.md); code changes need the affected documentation and relevant tests.

Run checks appropriate to the changed packages. PostgreSQL changes use the real database contract suite; documentation changes use `pnpm run doc-sync`. The Coffe CI workflow checks types, documentation, and PostgreSQL behavior on GitHub-hosted runners without model credentials.

## Upstream collaboration

Distinguish Coffe-specific behavior from inherited implementation when reporting a problem. Follow the upstream project's current contribution policy before submitting there. Keep upstream commit history and record provenance when importing changes; do not replace third-party license notices with Coffe branding.

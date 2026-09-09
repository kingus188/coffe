# Coffe

English | [中文](README.zh.md)

**Coffe is an independently maintained open-source fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), originally developed by [DeepSeek AI](https://deepseek.com).** Coffe builds on its plugin architecture to support self-hosted Agent runtimes and PostgreSQL-backed session storage. It is not an official DeepSeek release.

The underlying harness, Web UI, tools, SDKs, and plugin architecture come from DeepSeek Harness. Its plugin framework is [Cordis](https://github.com/cordiverse/cordis). See [upstream attribution and maintenance](UPSTREAM.md) for provenance and the relationship between the projects.

## What Coffe adds

- PostgreSQL session persistence with cross-process write ownership and transactional appends.
- Queryable message content, tool-call correlation, token accounting, and full-text SQL search.
- A shared `coffe` runtime database with `coffe_` table names, including in-place migration from legacy session tables.

These additions are implemented in the [PostgreSQL backend](packages/session/session-persistence-postgres/README.md). Multi-user permissions and a complete runtime administration console are not part of this release.

## Developer preview

Coffe and its upstream are evolving. Interfaces and configuration may change. Review the [safety notice](SAFETY.md) before running an Agent with access to files, commands, or external services.

<a id="run"></a>

## Run

<a id="run-from-source"></a>

### Run from source

Use Node.js `^22.19.0` or `>=24.0.0` and pnpm `11.7.0`:

```sh
git clone https://github.com/kingus188/coffe.git
cd coffe
pnpm install
pnpm run build
pnpm dsh web --no-open
```

The Web UI listens at `http://127.0.0.1:3080` by default. Configure your model provider before starting a conversation. See the [Web UI guide](docs/user/guide/index.md).

The retained `dsh` command and `@deepseek-ai/*` workspace names identify inherited interfaces. `npx @deepseek-ai/dsh` installs the upstream project, not this fork. Coffe does not yet publish its own npm or desktop releases; use this checkout to run its changes.

### PostgreSQL storage

PostgreSQL is optional. To use it, mount the [PostgreSQL persistence plugin](packages/session/session-persistence-postgres/README.md) in place of JSONL and point its connection configuration at your `coffe` database. Keep credentials outside Git. Existing JSONL sessions remain on their original backend.

## Documentation and support

- [Coffe Issues](https://github.com/kingus188/coffe/issues) for reproducible bugs and feature requests.
- [Coffe Discussions](https://github.com/kingus188/coffe/discussions) for usage and design questions.
- [Development guide](docs/development.md) and [architecture](docs/architecture.md) for the inherited harness and local implementation.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for upstream source, releases, and community links.

Documentation in this checkout includes inherited DeepSeek Harness material. References to upstream npm packages and official services describe upstream behavior; Coffe-specific storage and distribution details are documented here and in the linked backend README.

## Contributing

Coffe accepts issues and pull requests. Read [CONTRIBUTING.md](CONTRIBUTING.md). `main` is the public baseline; `dev` is the integration branch. Agent contributors follow [AGENTS.md](AGENTS.md).

## License and attribution

Coffe is distributed under the [MIT License](LICENSE). The original `Copyright (c) 2026 DeepSeek` notice and permission text are retained. Credit for the upstream implementation belongs to DeepSeek and the original contributors; Coffe changes are recorded in Git history.

Third-party licenses remain in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

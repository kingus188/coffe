# Agent Note: Coffe fork identity and upstream attribution

Status: implemented

English | [中文](2026-09-09-coffe-upstream-attribution.zh.md)

## Problem

A fork whose landing page, support links, and installation command identify only the upstream project sends users to the wrong maintainers and packages. Renaming every inherited technical identifier would also increase upstream merge costs without adding runtime behavior.

## Decision

Coffe identifies itself as an independent fork of DeepSeek Harness in both README introductions and repository metadata. [UPSTREAM.md](../../../../UPSTREAM.md) names the original authors, retained implementation, local additions, and synchronization policy. The MIT copyright notice and upstream history remain intact.

The public repository is `kingus188/coffe`, with `main` as the public baseline and `dev` as the integration branch. Support and documentation source links target Coffe; historical references and third-party origins keep their original destinations. Installation uses the source checkout. Internal package names and the `dsh` command remain inherited interfaces, and upstream npm/desktop channels are explicitly distinguished from Coffe distribution.

[Coffe CI](../../../../.github/workflows/coffe-ci.yml) runs on main/dev pushes and pull requests using a GitHub-hosted Linux runner without model credentials. It checks types, documentation, and PostgreSQL tests; its database lane requires Docker instead of accepting a skipped contract suite. Existing upstream release machinery is not a Coffe publishing channel.

## Alternatives considered

**Replace every DeepSeek name and URL.** Rejected because copyright, historical provenance, model-provider URLs, and retained package identities have different owners and meanings.

**Keep the original README installation command.** Rejected because it installs the upstream npm package and does not deliver Coffe's changes.

## Consequences

Readers can identify the project's source and the maintainers responsible for the fork. Source compatibility remains useful for upstream synchronization. Independent npm packages, desktop branding, distribution signing, and production documentation hosting require their own release work; none is implied by the repository rename.

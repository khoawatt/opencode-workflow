# Contributing to OpenCode Workflow (opencode-workflow)

Thank you for your interest in contributing to `opencode-workflow`! This project provides workflow automation and independent web-review bridges for OpenCode using ChatGPT Plus and Google Gemini Web.

---

## Code of Conduct

Please be respectful and constructive when reporting issues, discussing proposals, or reviewing PRs. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/khoawatt/opencode-workflow.git
   cd opencode-workflow
   ```

2. **Install bridge globally**:
   ```bash
   bash install.sh
   ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status
   ```

3. **Verify tests pass**:
   ```bash
   bash tests/test.sh
   bash -n bin/chatgpt-review.mjs bin/gemini-review.mjs
   ```

---

## Pull Request Guidelines

1. **Keep it focused**: One bugfix or feature per PR.
2. **Backward compatibility**: Ensure `@chatgpt-review`, `@gemini-review`, `opencode-work` and existing `opencode.jsonc` policies are not broken.
3. **Safe permissions**: Browser profiles and chat state must remain `0700`/`0600`; never commit `profile/`, `chats.json`, `projects.json`.
4. **No secrets**: Never commit cookies, tokens, `.env`, or session transcripts.
5. **Test before pushing**: `bash tests/test.sh` must pass.

---

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

---

## Author & Maintainers

* **Quách Võ Anh Khoa** ([@khoawatt](https://github.com/khoawatt)) — Author & Lead Maintainer
* **Audition MLD** ([@audition-mld](https://github.com/audition-mld)) — Contributor

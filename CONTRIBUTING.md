# Contributing

Thank you for helping with the pi engineering kit package. Bug reports, ideas and pull requests are welcome.

## Issues

- **Bugs and ideas:** open an issue with the bug report or feature request form.
- **A large change** (a new skill, an extension or gate behavior, a new install mode): open an issue first and agree on the approach before writing code.
- **Security vulnerabilities:** never in a public issue; see [SECURITY.md](SECURITY.md).
- **Conduct:** everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Requirements: Node.js 22.18 or newer (the tests and scripts run `.ts` files directly) and git.

```sh
npm ci
npm test
npm run typecheck
```

## Pull requests

- One change per branch and pull request; branch from `main`.
- Add or update tests for every behavior change: write the failing test first, and never weaken an existing test to get green.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) as in the history: `fix(verify): …`, `feat(guard): …`, `docs: …`.
- Add a line to `CHANGELOG.md` for every user-visible change, and update the docs the change makes stale.
- `main` is protected: a pull request merges once the `gate` check is green and it is up to date with `main`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) of this repository.

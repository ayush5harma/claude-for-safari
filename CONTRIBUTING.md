# Contributing to Claude for Safari

Thanks for helping improve Claude for Safari. Please start with an issue when
you want to propose a substantial change, so the problem and approach are
clear before implementation.

## Before you open a pull request

- Use a current Node.js 20 or later release for the JavaScript test suite.
- Keep changes focused. Do not mix refactors with unrelated behavior changes.
- Do not add credentials, API keys, local paths, generated Xcode projects, or
  build output to commits.
- Preserve the extension's Safari behavior and the bridge's local-first
  design. Changes that affect permissions, network access, or data handling
  should explain the user-facing effect in the pull request.

Run the automated tests from the repository root:

```sh
node --test test/*.test.js
```

The Safari app and iOS wrapper need Xcode and a local Safari installation to
build or test. If your change affects either, describe the manual checks you
were able to perform and any checks you could not run.

## Pull requests

Write a clear title and explain the problem, the resulting behavior, and how
you verified it. Include screenshots or a short recording for visible changes
to the extension or chat panel. Update documentation when installation,
configuration, or user-visible behavior changes.

By submitting a contribution, you agree that it may be distributed under this
repository's [MIT License](LICENSE).

@"
# license-guard

Automatically blocks git commits when npm dependencies use licenses that restrict commercial use — checked via SPDX rules, npm registry data, and AI verification.

## Install

npm install --save-dev license-guard

## Setup

1. Add your OpenAI API key to a .env file in your project root:

OPENAI_API_KEY=your-openai-key-here

2. A pre-commit hook is installed automatically via Husky — no extra setup needed.

## How it works

On every git commit, license-guard scans your dependencies and blocks the commit if any package's license restricts commercial use or can't be automatically verified.

## Overriding a package

After legal/manual review, approve a specific package by adding it to license-overrides.json in your project root:

{ "package-name@1.2.3": { "allowed": true, "reason": "approved by legal on 2026-09-23" } }

## License

MIT
"@ | Set-Content README.md
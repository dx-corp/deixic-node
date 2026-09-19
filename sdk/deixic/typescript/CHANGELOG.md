# Changelog

## Unreleased

- Add validated, source-linked account briefs, missing-data handling, progress
  output, explicit owner-authorized approvals/denials, and receipt outcomes.
- Verify clean package consumers over binary HTTP with killed workers, storage
  failures, lost responses and Python/TypeScript checkpoint interoperability.
- Atomically publish and sync private checkpoint files before submission.
- Restore TypeScript 7 builds and classify native fetch disconnects for bounded
  read recovery without retrying task mutations.

## [0.1.2](https://github.com/dx-corp/mono/compare/sdk/deixic/typescript/v0.1.1...sdk/deixic/typescript/v0.1.2) (2026-09-18)


### Features

* **sdk:** complete the recoverable account brief application ([#9650](https://github.com/dx-corp/mono/issues/9650)) ([efac3fc](https://github.com/dx-corp/mono/commit/efac3fc80aedcac02a119b5d142d53fb4b35230e))


### Chores

* **deps:** batch 100 open Dependabot updates into one PR ([#9616](https://github.com/dx-corp/mono/issues/9616)) ([bffa72a](https://github.com/dx-corp/mono/commit/bffa72ae007a079ee80fb38fd0b2facaa5714ff9))

## [0.1.1](https://github.com/dx-corp/mono/compare/sdk/deixic/typescript/v0.1.0...sdk/deixic/typescript/v0.1.1) (2026-09-18)


### Features

* **sdk:** add recoverable task results and account briefs ([#9602](https://github.com/dx-corp/mono/issues/9602)) ([2172f17](https://github.com/dx-corp/mono/commit/2172f1772cc919fbe3c7f1cf34fdd6d79d993fb2))
* **sdk:** ship public Deixic clients ([#9439](https://github.com/dx-corp/mono/issues/9439)) ([79c826f](https://github.com/dx-corp/mono/commit/79c826ffac8b07361056b1d4d072b3a6dd82e3f6))


### Bug Fixes

* **runtime:** derive runtime admission from capability catalog ([#8990](https://github.com/dx-corp/mono/issues/8990)) ([15b336c](https://github.com/dx-corp/mono/commit/15b336c392c5d36a7637f938baea69f9e165cdbb))


### Chores

* **deps:** bump the cargo group across 1 directory with 2 updates ([#9342](https://github.com/dx-corp/mono/issues/9342)) ([cf94c9a](https://github.com/dx-corp/mono/commit/cf94c9a949e588d68d2e1e54956f8f8e876d5aff))

## 0.1.0

- Publish the first Deixic TypeScript SDK for durable threads, events,
  messages, controls, receipt actions, and accepted-turn observation.

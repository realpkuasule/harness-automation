## [2.8.5] - 2026-09-01

### Fixed

- accept PascalCase JSX component aliases in TypeScript naming verification (b6dcb59)

## [2.8.1] - 2026-09-01

### Fixed

- harden owner-approved TypeScript naming adoption and unblock Harness self-governance (#68)
- prohibit dedicated npm release worktrees (#67)

## [2.8.0] - 2026-08-31

### Added

- recover delivery authorization across sessions (#65) (28b9b81)

## [2.7.1] - 2026-08-31

### Fixed

- stabilize self-hosted release tests (#62) (a0cfbc9)
- isolate Go build cache by account (#59) (
0f1ee0)
- skip slow Linux cache restore (#61) (
9a857f)

## [2.7.0] - 2026-08-31

### Added

- default to merged branch cleanup (#53) (68babbe)

## [2.6.0] - 2026-08-27

### Changed

- route release to self-hosted runner (97d4524)
- route trusted checks to self-hosted runners (#39) (
b6bba7)
- normalize Windows retention paths (
7279be)
- repair cross-platform coverage regression (
108ac4)

### Fixed

- report Actions SHA pinning (#40) (
a0442a)
- split Windows worktree test groups (
0895d5)
- restore cross-platform worktree checks (
bb2ce2)

### Added

- add read-only governance audit (
c23916)

## [2.5.0] - 2026-08-21

### Changed

- add package changelog (f1ea17a)

### Added

- add integration governance checks (
486ce3)

# Changelog

All notable package releases are recorded here. Repository-wide development
history remains in `../CHANGELOG.jsonl`.

## [2.4.1] - 2026-08-21

### Fixed

- Write close receipts from the management checkout.

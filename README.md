# tree-sitter-mailmap

[![CI](https://github.com/konomanoasa/tree-sitter-mailmap/actions/workflows/ci.yaml/badge.svg)](https://github.com/konomanoasa/tree-sitter-mailmap/actions/workflows/ci.yaml)
[![crates.io](https://img.shields.io/crates/v/konomanoasa-tree-sitter-mailmap)](https://crates.io/crates/konomanoasa-tree-sitter-mailmap)
[![npm](https://img.shields.io/npm/v/@konomanoasa/tree-sitter-mailmap)](https://www.npmjs.com/package/@konomanoasa/tree-sitter-mailmap)

[Tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for
Git mailmap files 2.55.0.

## Syntax Issues

The parser detects syntax issues, including missing syntax, while preserving the surrounding structure.
These issues are represented as `syntax_issue` nodes.

## Installation

```sh
npm install @konomanoasa/tree-sitter-mailmap
```

## Development

Development uses Node.js 24.21.0 or later.

```sh
npm install
npm run build
npm test
```

## Specification

[Git 2.55.0 gitmailmap manual](https://git-scm.com/docs/gitmailmap/2.55.0)

## License

[MIT](LICENSE)

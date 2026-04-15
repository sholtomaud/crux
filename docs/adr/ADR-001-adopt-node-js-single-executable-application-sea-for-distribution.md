# ADR-001: Adopt Node.js Single Executable Application (SEA) for Distribution

**Status:** accepted  
**Date:** 2026-04-15

## Context

The project requires a portable, zero-installation experience for a personal project manager. Users should not need to install Node.js separately, and the application must run on any supported OS without external dependencies.

## Decision

The application is built as a Node.js SEA using esbuild to bundle TypeScript to CJS, then postject to inject the blob into the Node binary. The final binary contains the Node.js runtime, compiled code, and all static UI assets inlined as strings. Signed with codesign at final install path — not before cp — to preserve page hashes on macOS.

## Consequences

Build complexity increases: requires container with Node 25, postject, and macOS arm64 Node tarball download. Debugging production binary is harder. Binary is ~60MB. Distribution is trivial — single file, no npm install on host. codesign must happen after cp to ~/bin or macOS 26.4 will SIGKILL the process.
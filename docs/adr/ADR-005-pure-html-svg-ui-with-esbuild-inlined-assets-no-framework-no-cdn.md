# ADR-005: Pure HTML/SVG UI with esbuild-inlined assets — no framework, no CDN

**Status:** accepted  
**Date:** 2026-04-15

## Context

The browser UI must be self-contained, offline-capable, and load instantly from the local HTTP server. CDN dependencies are a failure point and security risk for a local-first tool. UI frameworks add weight and build complexity disproportionate to the scope.

## Decision

UI written in vanilla HTML, CSS, and SVG using standard DOM APIs (createElementNS for SVG). No React, Vue, d3, or dagre. No CDN script tags. All UI source files (index.html, project.html, graph.html, etc.) are read at bundle time by a custom esbuild plugin and inlined as string literals in the CJS bundle. The HTTP server in lib/server.ts serves them from the UI_ASSETS map.

## Consequences

No component abstractions — each page is a self-contained HTML file with inline script. Build required to see UI changes in SEA binary; dev mode reads from disk on server restart. Graph rendering uses a custom topo-sort lane-assignment layout algorithm instead of dagre. No npm UI dependencies to audit or update.
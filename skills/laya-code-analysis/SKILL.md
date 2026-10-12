---
name: laya-code-analysis
description: Analyzes codebase syntax, functions, classes, and symbol references using native tree-sitter AST queries via Laya MCP tools.
author: Hypokoto
date: 2026-10-12
version: 1.0.0
triggers: Analyze code structure, Find usages, tree-sitter analysis, trace this function, find all references, inspect symbols
---

# Laya Code Analysis

## Purpose

Guides the AI agent in leveraging Laya's native tree-sitter integration to perform structural, Abstract Syntax Tree (AST)-based code analysis without reading thousands of lines of raw text into the context window.

## When to Use This Skill

Activate this skill when:
- Exploring new source files to map out classes, methods, and functions
- Preparing for refactoring where all syntactic references to a symbol must be found
- Navigating large codebases where standard text-based regex/grep produces false positives
- Analyzing Python, C, or C++ source structures

## Core Capabilities

1. **AST Symbol Extraction**: Parses Python/C/C++ files to extract all defined classes and functions along with exact line numbers.
2. **Context Window Conservation**: Returns concise symbol skeletons rather than raw file dumps.
3. **Semantic Reference Discovery**: Queries syntactic AST nodes rather than raw strings.

## Step-by-Step Instructions

1. **Discover File Skeletons**:
   - Invoke `laya_analyze_code` with `filepath`.
   - Review the extracted list of `function` and `class` definitions and their line ranges.
2. **Targeted Reading**:
   - Instead of reading the entire file, use line-targeted reading or inspect specific functions identified by the analysis.
3. **Locate Metadata and Dependencies**:
   - Call `laya_inspect_metadata` to quickly inspect `package.json`, `pyproject.toml`, or `CMakeLists.txt` for dependencies.

## Progressive Disclosure

- Advanced tree-sitter queries and supported language grammars: see [references/tree-sitter-queries.md](references/tree-sitter-queries.md)
- Real workflow walkthroughs: see [examples/ast-exploration.md](examples/ast-exploration.md)

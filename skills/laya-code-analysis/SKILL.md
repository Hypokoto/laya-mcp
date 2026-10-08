---
name: laya-code-analysis
description: Instructions for using Laya's tree-sitter integration to perform deep syntactic and structural codebase analysis.
author: Hypokoto
date: 2026-10-08
version: 1.0.0
triggers: Analyze code structure, Find usages, tree-sitter analysis, trace this function, find all references
---

# Laya Code Analysis

## Purpose
The Laya MCP Server provides powerful code structural analysis tools backed by native `tree-sitter`. This skill guides you in using these tools to understand complex codebases semantically rather than relying on standard text searches.

## Available Tools

1. **`laya_analyze_code`**
   - **Usage:** Extracts structural components like classes, functions, and interfaces from a file.
   - **When to use:** Use this when you need an overview of a file's architecture without reading the entire source code into your context window. It returns the semantic skeleton of the code.

2. **`laya_find_usages`**
   - **Usage:** Uses tree-sitter query syntax to find exact syntactic references to a specific function or variable.
   - **When to use:** Use this when you are refactoring a function and need to find every place it is called across the codebase. This is much more accurate than a standard `grep` because it understands the AST (Abstract Syntax Tree).

## Best Practices
- **Prefer AST over Regex:** When trying to find function calls or class definitions, always use `laya_find_usages` instead of raw text searching tools.
- **Context Management:** If a file is extremely large, use `laya_analyze_code` to get the map of functions first, rather than reading thousands of lines of raw text.
- **Understand Limitations:** The tree-sitter CLI relies on the system having the correct language parsers installed (`/usr/lib/tree_sitter/<lang>.so`). If a language is unsupported, gracefully fall back to standard search methods.

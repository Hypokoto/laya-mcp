# Laya Code Analysis Skill

A semantic code analysis skill for AI coding harnesses backed by native Tree-Sitter grammars and the Laya MCP Server.

## Overview

Text-based tools like `grep` struggle with semantic code comprehension—they match comments, string literals, and variable names interchangeably. The Laya Code Analysis skill instructs AI agents to use native AST (Abstract Syntax Tree) queries via the `laya_analyze_code` tool.

This enables instant extraction of class hierarchies, function definitions, and type signatures across Python and C/C++ files while consuming minimal context window tokens.

## Supported Languages

- **Python** (`.py`)
- **C** (`.c`, `.h`)
- **C++** (`.cpp`, `.cc`, `.hpp`)

## Installation

### Local Repository
Located at `skills/laya-code-analysis/`.

### Global Installation
```bash
ln -sf $(pwd)/skills/laya-code-analysis ~/.claude/skills/laya-code-analysis
ln -sf $(pwd)/skills/laya-code-analysis ~/.gemini/config/skills/laya-code-analysis
```

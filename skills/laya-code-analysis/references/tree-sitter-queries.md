# Technical Reference: Tree-Sitter AST Queries

## Query Patterns

Laya MCP executes compiled tree-sitter SCM queries against source files using system grammar libraries (e.g., `/usr/lib/tree_sitter/python.so`).

### Python Query Schema:
```scheme
(function_definition name: (identifier) @function)
(class_definition name: (identifier) @class)
```

### C Query Schema:
```scheme
(function_definition declarator: (function_declarator declarator: (identifier) @function))
(struct_specifier name: (type_identifier) @class)
```

### C++ Query Schema:
```scheme
(function_definition declarator: (function_declarator declarator: (identifier) @function))
(function_definition declarator: (function_declarator declarator: (field_identifier) @function))
(class_specifier name: (type_identifier) @class)
(struct_specifier name: (type_identifier) @class)
```

## Performance & Context Optimization

Extracting symbols via Tree-Sitter runs in <5ms and compresses a 2,000-line source file into ~15 lines of concise symbol definitions, saving over 95% of LLM context window tokens during codebase exploration.

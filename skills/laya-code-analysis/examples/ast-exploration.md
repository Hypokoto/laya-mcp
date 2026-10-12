# Example Workflow: AST-Based Exploration

## Scenario: Exploring an Unfamiliar Python Server

### 1. Agent analyzes file structure:
```json
{
  "name": "laya_analyze_code",
  "arguments": {
    "filepath": "laya_runtime/main.py"
  }
}
```

### 2. Output returned by tool:
```
Symbols found in laya_runtime/main.py:
- [Line 25] class: DecisionRequest
- [Line 31] class: DecisionResponse
- [Line 42] function: load_model
- [Line 78] function: build_sequence
- [Line 115] function: decide
- [Line 150] function: start
```

### 3. Agent Insight:
Rather than reading all 180 lines of Python code, the agent immediately knows that:
- `DecisionRequest` and `DecisionResponse` define the data schemas.
- `decide` is the handler endpoint on Line 115.
- `build_sequence` handles token construction on Line 78.

The agent can now inspect only the specific lines it needs using targeted tools.

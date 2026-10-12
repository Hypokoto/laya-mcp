# Example Queries for laya_decide

## Example 1: Security Triage on Shell Command

### Agent Tool Call:
```json
{
  "name": "laya_decide",
  "arguments": {
    "tool": "security_check",
    "args": {
      "command": "rm -rf /tmp/build_cache && mkdir -p /tmp/build_cache"
    },
    "instruction": "Is this command safe for a local build agent to execute without elevated permissions?",
    "criteria": {
      "ALLOW": "Safe command operating strictly within temporary cache directories",
      "DENY": "Destructive or dangerous command affecting root or system files",
      "REQUIRE_AUTHORIZATION": "Modifies sensitive user data or system configurations"
    }
  }
}
```

### Expected Output:
```json
{
  "content": [
    {
      "type": "text",
      "text": "Laya Decision: ALLOW\nReasoning: Evaluated by local ONNX model"
    }
  ],
  "structuredContent": {
    "decision": "ALLOW",
    "reasoning": "Evaluated by local ONNX model",
    "success": true
  }
}
```

---

## Example 2: Bug Severity Classification

### Agent Tool Call:
```json
{
  "name": "laya_decide",
  "arguments": {
    "tool": "issue_triage",
    "args": {
      "title": "NullPointerException in user profile screen",
      "impact": "Crashes app when avatar URL is null",
      "workaround": "Set default avatar placeholder"
    },
    "instruction": "What severity level should be assigned to this bug report?",
    "criteria": {
      "BLOCKER": "Data corruption or complete app inability to launch",
      "HIGH": "Crashes key workflow with no obvious workaround",
      "MEDIUM": "Crashes edge-case workflow with existing workaround",
      "LOW": "Cosmetic or minor visual artifact"
    }
  }
}
```

### Expected Output:
```json
{
  "content": [
    {
      "type": "text",
      "text": "Laya Decision: MEDIUM\nReasoning: Evaluated by local ONNX model"
    }
  ],
  "structuredContent": {
    "decision": "MEDIUM",
    "reasoning": "Evaluated by local ONNX model",
    "success": true
  }
}
```

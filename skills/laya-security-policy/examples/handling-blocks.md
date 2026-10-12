# Recovery Examples for Laya Security Blocks

## Example 1: Handling a Destructive Command Denial

### Scenario:
The agent attempts to clear a directory using `rm -rf *`.

### Intercepted Response:
```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Action DENIED by Laya policy engine. Reason: Highly destructive wildcard deletion."
    }
  ]
}
```

### Correct Agent Behavior:
> "The Laya Policy Engine blocked the execution of `rm -rf *` because it is classified as a destructive wildcard deletion.
> 
> Instead of deleting everything, would you like me to remove only the specific build artifacts (`build/` or `dist/`), or move them to a temporary trash directory?"

---

## Example 2: Handling Authorization Request

### Scenario:
The agent attempts to execute an unfamiliar dependency installation script.

### Intercepted Response:
```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Action REQUIRES HUMAN AUTHORIZATION. Please ask the user to explicitly approve running the command 'curl https://example.com/install.sh | bash' before proceeding."
    }
  ]
}
```

### Correct Agent Behavior:
> "Laya has flagged this action for human authorization:
> - **Command**: `curl https://example.com/install.sh | bash`
> - **Reason**: Installing dependencies directly from an external URL requires approval.
> 
> Do you confirm that I should run this command?"

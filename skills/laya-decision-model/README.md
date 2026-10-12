# Laya Decision Model Skill

A specialized AI agent skill for executing calibrated classification, prioritization, and routing decisions using the local Laya ONNX inference model.

## Overview

Modern LLMs frequently suffer from overconfidence, hallucinated probabilities, and slow inference times when asked to classify structured data. The Laya Decision Model is a 421M-parameter ModernBERT-based encoder with a specialized decision head trained to output mathematically calibrated logits across discrete options.

This skill equips any AI agent harness (Cursor, Claude Desktop, Claude Code, Windsurf, Cline) with instructions on how to leverage the `laya_decide` tool exposed by the Laya MCP Server.

## Key Features

- **Fast Local Inference**: Evaluates choices on local CPU/GPU in milliseconds without external API latency.
- **Calibrated Uncertainty**: Distinguishes between confident and borderline decisions.
- **Structured Inputs**: Accepts native JSON payloads and discrete criteria dictionaries.

## Installation

### Local Repository
This skill is located at `skills/laya-decision-model/`.

### Global Installation
Symlink this directory to your global agent skills folder:
```bash
ln -sf $(pwd)/skills/laya-decision-model ~/.claude/skills/laya-decision-model
ln -sf $(pwd)/skills/laya-decision-model ~/.gemini/config/skills/laya-decision-model
```

## Example Usage

When a user asks:
> *"Use Laya to triage these three error logs and classify their severity"*

The agent automatically formats the error stack into an input payload, establishes criteria (`CRITICAL`, `WARNING`, `INFO`), and queries `laya_decide`.

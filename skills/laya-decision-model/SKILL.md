---
name: laya-decision-model
description: Evaluates structured data using the Laya ONNX decision model to produce calibrated classification, scoring, routing, and probability assessments.
author: Hypokoto
date: 2026-10-12
version: 1.0.0
triggers: Use Laya to classify this, Run this through Laya, Use the Laya MCP to decide, Score/classify these items with Laya, Route these based on Laya's decision model, Laya decision
---

# Laya Decision Model

## Purpose

Enables the AI agent to make fast, mathematically calibrated decisions from structured data using the local Laya ONNX decision model. This skill guides the agent in formatting state payloads, constructing typed choice/score/noul questions, and interpreting calibrated logits rather than relying on uncalibrated LLM text generation.

## When to Use This Skill

Activate this skill when:
- Classifying or categorizing complex objects, code snippets, or user intents
- Prioritizing or scoring items against explicit criteria
- Requiring reliable yes/no probability assessments
- Offloading decision routing to a fast local model (<10ms inference)

## Core Capabilities

1. **Choice Classification**: Evaluates a payload against discrete keys with criteria descriptions.
2. **Confidence Calibration**: Interprets output logits to measure certainty.
3. **Structured State Construction**: Formats complex JSON state into compact key-value dictionaries.

## Step-by-Step Instructions

1. **Extract State Payload**: Summarize the data to be evaluated into a clean dictionary (`args`).
2. **Formulate Question (`instruction`)**: Write an explicit, unambiguous single-sentence question.
3. **Define Criteria (`criteria`)**: Provide mutually exclusive keys with clear boundaries:
   ```json
   {
     "ALLOW": "Safe, read-only, or expected non-destructive behavior",
     "DENY": "Destructive or dangerous actions (e.g. data loss, deletion)",
     "REVIEW": "Ambiguous actions requiring human verification"
   }
   ```
4. **Invoke `laya_decide`**:
   - `tool`: Context identifier (e.g., `"security_evaluation"`, `"triage"`)
   - `args`: Extracted payload
   - `instruction`: Formulated question
   - `criteria`: Defined criteria mapping
5. **Act on Decision**:
   - Use the returned `decision` string directly to drive control flow.
   - If confidence or reasoning is provided, summarize it briefly for the user.

## Progressive Disclosure

- Detailed decision theory and calibration metrics: see [references/decision-theory.md](references/decision-theory.md)
- Complete prompt and tool execution examples: see [examples/sample-queries.md](examples/sample-queries.md)

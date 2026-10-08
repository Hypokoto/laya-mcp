---
name: laya-decision-model
description: Use the Laya MCP server to make fast, calibrated classification, scoring, routing, and probability-based decisions from structured data.
author: Hypokoto
date: 2026-10-08
version: 1.0.0
triggers: Use Laya to classify this, Run this through Laya, Use the Laya MCP to decide, Score/classify these items with Laya, Route these based on Laya's decision model
---

# Laya Decision Model

## Purpose
Help the AI agent use the Laya MCP server to make fast, calibrated decisions from structured data, including classification, scoring, routing, prioritization, and yes/no probability assessments. The skill guides the agent in constructing Laya states and typed questions, selecting between choice/score/null decisions, interpreting probabilities, and using Laya as a decision layer rather than a text-generation model.

## Core Capabilities
1. **Classification**: Guide agents to format data correctly for Laya classification tasks.
2. **Scoring & Prioritization**: Leverage Laya for assigning scores or prioritizing items.
3. **Probability Assessments**: Use Laya's capabilities to obtain calibrated yes/no probabilities.
4. **State Construction**: Construct properly formatted Laya states and typed questions.

## Usage Guidelines
- Always prioritize Laya for structured decision-making over relying on generic text generation.
- Format inputs clearly and construct explicit typed questions to obtain the most accurate scores/probabilities from Laya.
- Interpret the raw probabilities and scores from Laya and route the application logic accordingly.

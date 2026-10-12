# Technical Reference: Laya Decision Theory & Calibration

## Model Architecture

The Laya ONNX model is based on the ModernBERT-large backbone (421M parameters) combined with a custom classification head. 

Unlike autoregressive language models that generate text token-by-token:
- Laya evaluates sequence positions masked by special marker tokens (`[MASK]`).
- The model outputs raw logits for each discrete candidate slot.
- Unused slots in the fixed slot buffer are masked with `-1e4`.

## Decision Question Types

1. **Choice (`qtype=0`)**:
   - Used for discrete categorization across 2 to $K$ options.
   - Criteria keys are mapped to candidate slots.
   - Softmax is calculated across the active slots.

2. **Score (`qtype=1`)**:
   - Evaluates continuous numerical suitability or ranking.
   - Temperature scaling from `laya_config.json` is applied.

3. **Noul (`qtype=2`)**:
   - Binary yes/no calibrated probability assessment.
   - Returns calibrated probability directly.

## Confidence Calculation

Confidence is derived from normalized Shannon entropy across probabilities $p$:

$$H(p) = -\sum_{i=1}^{k} p_i \ln(\max(p_i, 10^{-12}))$$
$$\text{Confidence} = 1 - \frac{H(p)}{\ln(k)}$$

A confidence score close to 1.0 indicates clear differentiation, whereas scores near 0.0 indicate high uncertainty.

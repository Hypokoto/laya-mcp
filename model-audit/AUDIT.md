# Laya Model Audit Report (Phase 0)

## 1. Artifact Hashes & Specifications

- **Target INT8 Model**: `laya_int8.onnx`
  - Size: 583,047,211 bytes (~557 MB)
  - Format: Single self-contained ONNX file with embedded INT8 weights and FP32 scorer head (`node_MatMul_3223`, `node_MatMul_3232`).
- **Golden FP32 Reference Model**: `laya.onnx` + `laya.onnx.data`
  - Graph size: 3,807,291 bytes
  - External weights: 1,685,258,240 bytes (~1.68 GB)
- **ONNX IR Version**: 10
- **Opset Version**: `ai.onnx: 18`

## 2. Declared Graph Inputs & Outputs

### Inputs
1. `input_ids`: `INT64 [batch, seq]` — BPE token identifiers with special tokens `[CLS]`, `[SEP]`, `[MASK]`.
2. `attention_mask`: `INT64 [batch, seq]` — All 1s for active token positions.
3. `marker_pos`: `INT64 [batch, options]` — Sequence index positions corresponding to `[MASK]` tokens.
4. `marker_mask`: `BOOL [batch, options]` — Boolean mask indicating valid marker positions.
5. `qtype`: `INT64 [batch]` — Decision primitive: `0` for `choice`, `1` for `score`, `2` for `noul`.

### Outputs
1. `logits`: `FLOAT [batch, options]` — Unnormalized decision scores over each candidate option.
2. `act_probs`: `FLOAT [batch, 2]` — Action probabilities.

## 3. Tokenizer & Preprocessing Contract

- **Tokenizer File**: `tokenizer/tokenizer.json` (Hugging Face Fast BPE Tokenizer)
- **Config**: `tokenizer/tokenizer_config.json`
- **Special Token Identifiers**:
  - `[CLS]`: `50281`
  - `[SEP]`: `50282`
  - `[PAD]`: `50283`
  - `[MASK]`: `50284`
  - `[UNK]`: `50280`
- **Sequence Budgets**:
  - `max_len`: 512
  - `head_max_len`: 192
  - Option token limit: 48 tokens per option
- **Sequence Construction Order**:
  ```
  [CLS] + head_ids + [SEP] + [MASK] + opt1_ids + [MASK] + opt2_ids + ... + [SEP] + state_ids + [SEP]
  ```
- **Temperature Map (`laya_config.json`)**:
  - `choice:2`: 1.906356
  - `choice:3-5`: 1.760152
  - `choice:6-10`: 1.000016
  - `choice:11+`: 0.100583
  - `score:3-5`: 1.251430
  - `noul:2`: 1.983400

import os
import sys
import time
import gc
import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType

def main():
    raw_model = "laya.onnx"
    clean_model = "laya_clean.onnx"
    output_model = "laya_int8.onnx"
    
    print(f"[*] Step 1: Cleaning static shape conflicts from {raw_model}...")
    model = onnx.load(raw_model, load_external_data=False)
    model.graph.ClearField("value_info")
    onnx.save_model(model, clean_model)
    del model
    gc.collect()
    print(f"[+] Saved clean graph to {clean_model} ({os.path.getsize(clean_model)/1024/1024:.2f} MB)")
    
    print("[*] Step 2: Running dynamic INT8 quantization on MatMul layers...")
    start_time = time.time()
    
    quantize_dynamic(
        model_input=clean_model,
        model_output=output_model,
        op_types_to_quantize=["MatMul"],
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False
    )
    
    elapsed = time.time() - start_time
    print(f"[+] Quantization finished in {elapsed:.2f} seconds!")
    
    # Cleanup intermediate clean model
    try:
        os.remove(clean_model)
    except OSError:
        pass
        
    if os.path.exists(output_model):
        size_mb = os.path.getsize(output_model) / (1024 * 1024)
        print(f"[+] Quantized INT8 model created: {output_model} ({size_mb:.2f} MB)")
    else:
        print("[-] Error: Output model file was not found.")
        sys.exit(1)

if __name__ == "__main__":
    main()

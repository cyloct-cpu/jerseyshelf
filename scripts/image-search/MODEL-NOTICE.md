# Model provenance

The preview uses the SigLIP 2 Base 224 vision encoder from Google, distributed as a quantized ONNX conversion by ONNX Community. It does not use the text encoder or download code from the model repository.

- Original model and Apache-2.0 license declaration: https://huggingface.co/google/siglip2-base-patch16-224
- Converted weights: https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX
- Pinned conversion revision: `ba1f3b0843f24bc5417d38e19c37b287d719b2f4`
- File: `onnx/vision_model_quantized.onnx`
- SHA-256: `5f2b401c1a4fc095702a5d45348e17ad46c4f87064085365b43c6e8eaa5c0070`
- License text: https://www.apache.org/licenses/LICENSE-2.0.txt

The original model was trained by Google; this application does not claim authorship of the model. Conversion, quantization, and local preprocessing may affect retrieval results. The downloaded conversion model card is retained alongside the model. Preserve this notice and relevant upstream license materials when distributing the model.

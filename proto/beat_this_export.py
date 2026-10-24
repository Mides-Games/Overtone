"""Export the Beat This! network to assets/models/beat_this_final0.onnx.

Run once, in an environment that has torch and beat_this (never the app's):

    python -m venv btv
    btv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
    btv/Scripts/python -m pip install "beat_this @ https://github.com/CPJKU/beat_this/archive/main.zip" onnx
    btv/Scripts/python proto/beat_this_export.py assets/models/beat_this_final0.onnx

The checkpoint is downloaded by beat_this on first use. Only the network is
exported: the log-mel input and the peak picking are Overtone's own
(python/overtone.py), so the app needs onnxruntime and nothing of torch.
Record the result's SHA-256 in assets/models/beat_this.json.
"""
import sys

import torch

from beat_this.inference import load_model


class Net(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect):                 # (1, frames, 128)
        out = self.model(spect)
        return out["beat"], out["downbeat"]


def main() -> None:
    target = sys.argv[1]
    net = Net(load_model("final0", torch.device("cpu")).eval())
    torch.onnx.export(net, (torch.randn(1, 1500, 128),), target,
                      input_names=["spect"], output_names=["beat", "downbeat"],
                      dynamic_axes={"spect": {1: "time"}, "beat": {1: "time"},
                                    "downbeat": {1: "time"}},
                      opset_version=17, dynamo=False)
    print("wrote", target)


if __name__ == "__main__":
    main()

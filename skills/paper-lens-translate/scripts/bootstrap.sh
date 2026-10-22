#!/bin/bash
set -euo pipefail
tool_dir="${1:?Usage: bootstrap.sh TOOL_DIR}"
mkdir -p "$tool_dir"
export UV_INSTALL_DIR="$tool_dir/bin"
export UV_PYTHON_INSTALL_DIR="$tool_dir/python"
export UV_CACHE_DIR="$tool_dir/cache"
if [ ! -x "$tool_dir/bin/uv" ]; then
  curl --fail --location --retry 2 https://astral.sh/uv/0.9.4/install.sh -o "$tool_dir/install-uv.sh"
  UV_NO_MODIFY_PATH=1 bash "$tool_dir/install-uv.sh"
fi
if [ ! -x "$tool_dir/venv/bin/python" ]; then
  "$tool_dir/bin/uv" python install 3.12.12
  "$tool_dir/bin/uv" venv --python 3.12.12 "$tool_dir/venv"
fi
"$tool_dir/bin/uv" pip install --python "$tool_dir/venv/bin/python" PyMuPDF==1.25.5
"$tool_dir/venv/bin/python" -c 'import pymupdf; assert pymupdf.VersionBind == "1.25.5"; print("Paper Lens translation environment ready")'

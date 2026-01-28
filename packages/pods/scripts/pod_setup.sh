#!/usr/bin/env bash
# GPU pod bootstrap for vLLM deployment
set -euo pipefail

# Parse arguments passed from mu CLI
MOUNT_COMMAND=""
MODELS_PATH=""
HF_TOKEN=""
MU_API_KEY=""
VLLM_VERSION="release"  # Default to release

while [[ $# -gt 0 ]]; do
    case $1 in
        --mount)
            MOUNT_COMMAND="$2"
            shift 2
            ;;
        --models-path)
            MODELS_PATH="$2"
            shift 2
            ;;
        --hf-token)
            HF_TOKEN="$2"
            shift 2
            ;;
        --vllm-api-key)
            MU_API_KEY="$2"
            shift 2
            ;;
        --vllm)
            VLLM_VERSION="$2"
            shift 2
            ;;
        *)
            echo "ERROR: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$HF_TOKEN" ]; then
    echo "ERROR: HF_TOKEN is required" >&2
    exit 1
fi

if [ -z "$MU_API_KEY" ]; then
    echo "ERROR: MU_API_KEY is required" >&2
    exit 1
fi

if [ -z "$MODELS_PATH" ]; then
    echo "ERROR: MODELS_PATH is required" >&2
    exit 1
fi

echo "=== Starting pod setup ==="

# Install system dependencies
apt update -y
apt install -y python3-pip python3-venv git build-essential cmake ninja-build curl wget lsb-release htop pkg-config

# --- Install matching CUDA toolkit -------------------------------------------
echo "Checking CUDA driver version..."
DRIVER_CUDA_VERSION=$(nvidia-smi | grep "CUDA Version" | awk '{print $9}')
echo "Driver supports CUDA: $DRIVER_CUDA_VERSION"

# Check if nvcc exists and its version
if command -v nvcc &> /dev/null; then
    NVCC_VERSION=$(nvcc --version | grep "release" | awk '{print $6}' | cut -d, -f1)
    echo "Current nvcc version: $NVCC_VERSION"
else
    NVCC_VERSION="none"
    echo "nvcc not found"
fi

# Install CUDA toolkit matching driver version if needed
if [[ "$NVCC_VERSION" != "$DRIVER_CUDA_VERSION" ]]; then
    echo "Installing CUDA Toolkit $DRIVER_CUDA_VERSION to match driver..."

    # Detect Ubuntu version
    UBUNTU_VERSION=$(lsb_release -rs)
    UBUNTU_CODENAME=$(lsb_release -cs)

    echo "Detected Ubuntu $UBUNTU_VERSION ($UBUNTU_CODENAME)"

    # Map Ubuntu version to NVIDIA repo path
    if [[ "$UBUNTU_VERSION" == "24.04" ]]; then
        REPO_PATH="ubuntu2404"
    elif [[ "$UBUNTU_VERSION" == "22.04" ]]; then
        REPO_PATH="ubuntu2204"
    elif [[ "$UBUNTU_VERSION" == "20.04" ]]; then
        REPO_PATH="ubuntu2004"
    else
        echo "Warning: Unsupported Ubuntu version $UBUNTU_VERSION, trying ubuntu2204"
        REPO_PATH="ubuntu2204"
    fi

    # Add NVIDIA package repositories
    wget https://developer.download.nvidia.com/compute/cuda/repos/${REPO_PATH}/x86_64/cuda-keyring_1.1-1_all.deb
    dpkg -i cuda-keyring_1.1-1_all.deb
    rm cuda-keyring_1.1-1_all.deb
    apt-get update

    # Install specific CUDA toolkit version
    # Convert version format (12.9 -> 12-9)
    CUDA_VERSION_APT=$(echo $DRIVER_CUDA_VERSION | sed 's/\./-/')
    echo "Installing cuda-toolkit-${CUDA_VERSION_APT}..."
    apt-get install -y cuda-toolkit-${CUDA_VERSION_APT}

    # Add CUDA to PATH
    export PATH=/usr/local/cuda-${DRIVER_CUDA_VERSION}/bin:$PATH
    export LD_LIBRARY_PATH=/usr/local/cuda-${DRIVER_CUDA_VERSION}/lib64:${LD_LIBRARY_PATH:-}

    # Verify installation
    nvcc --version
else
    echo "CUDA toolkit $NVCC_VERSION matches driver version"
    export PATH=/usr/local/cuda-${DRIVER_CUDA_VERSION}/bin:$PATH
    export LD_LIBRARY_PATH=/usr/local/cuda-${DRIVER_CUDA_VERSION}/lib64:${LD_LIBRARY_PATH:-}
fi

# --- Install uv (fast Python package manager) --------------------------------
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# --- Install Python 3.12 if not available ------------------------------------
if ! command -v python3.12 &> /dev/null; then
    echo "Python 3.12 not found. Installing via uv..."
    uv python install 3.12
fi

# --- Clean up existing environments and caches -------------------------------
echo "Cleaning up existing environments and caches..."

# Remove existing venv for a clean installation
VENV="$HOME/venv"
if [ -d "$VENV" ]; then
    echo "Removing existing virtual environment..."
    rm -rf "$VENV"
fi

# Remove uv cache to ensure fresh installs
if [ -d "$HOME/.cache/uv" ]; then
    echo "Clearing uv cache..."
    rm -rf "$HOME/.cache/uv"
fi

# Remove vLLM cache to avoid conflicts
if [ -d "$HOME/.cache/vllm" ]; then
    echo "Clearing vLLM cache..."
    rm -rf "$HOME/.cache/vllm"
fi

# --- Create and activate venv ------------------------------------------------
echo "Creating fresh virtual environment..."
uv venv --python 3.12 --seed "$VENV"
source "$VENV/bin/activate"

# --- Install PyTorch and vLLM ------------------------------------------------
echo "Installing vLLM and dependencies (version: $VLLM_VERSION)..."
case "$VLLM_VERSION" in
    release)
        echo "Installing vLLM release with PyTorch..."
        # Install vLLM with automatic PyTorch backend selection
        # vLLM will automatically install the correct PyTorch version
        uv pip install vllm>=0.10.0 --torch-backend=auto || {
            echo "ERROR: Failed to install vLLM"
            exit 1
        }
        ;;
    nightly)
        echo "Installing vLLM nightly with PyTorch..."
        echo "This will install the latest nightly build of vLLM..."

        # Install vLLM nightly with PyTorch
        uv pip install -U vllm \
            --torch-backend=auto \
            --extra-index-url https://wheels.vllm.ai/nightly || {
            echo "ERROR: Failed to install vLLM nightly"
            exit 1
        }

        echo "vLLM nightly successfully installed!"
        ;;
    gpt-oss)
        echo "Installing GPT-OSS special build with PyTorch nightly..."
        echo "WARNING: This build is ONLY for GPT-OSS models!"
        echo "Installing PyTorch nightly and cutting-edge dependencies..."

        # Convert CUDA version format for PyTorch (12.4 -> cu124)
        PYTORCH_CUDA="cu$(echo $DRIVER_CUDA_VERSION | sed 's/\.//')"
        echo "Using PyTorch nightly with ${PYTORCH_CUDA} (driver supports ${DRIVER_CUDA_VERSION})"

        # The GPT-OSS build will pull PyTorch nightly and other dependencies
        # via the extra index URLs. We don't pre-install torch here to avoid conflicts.
        uv pip install --pre vllm==0.10.1+gptoss \
            --extra-index-url https://wheels.vllm.ai/gpt-oss/ \
            --extra-index-url https://download.pytorch.org/whl/nightly/${PYTORCH_CUDA} \
            --index-strategy unsafe-best-match || {
            echo "ERROR: Failed to install GPT-OSS vLLM build"
            echo "This automatically installs PyTorch nightly with ${PYTORCH_CUDA}, Triton nightly, and other dependencies"
            exit 1
        }

        # Install gpt-oss library for tool support
        uv pip install gpt-oss || {
            echo "WARNING: Failed to install gpt-oss library (needed for tool use)"
        }
        ;;
    *)
        echo "ERROR: Unknown vLLM version: $VLLM_VERSION"
        exit 1
        ;;
esac

# --- Install additional packages ---------------------------------------------
echo "Installing additional packages..."
# Note: tensorrt removed temporarily due to CUDA 13.0 compatibility issues
# TensorRT still depends on deprecated nvidia-cuda-runtime-cu13 package
uv pip install huggingface-hub psutil hf_transfer

# --- FlashInfer installation (optional, improves performance) ----------------
echo "Attempting FlashInfer installation (optional)..."
if uv pip install flashinfer-python; then
    echo "FlashInfer installed successfully"
else
    echo "FlashInfer not available, using Flash Attention instead"
fi

# --- Mount storage if provided -----------------------------------------------
if [ -n "$MOUNT_COMMAND" ]; then
    echo "Setting up mount..."

    # Create mount point directory if it doesn't exist
    mkdir -p "$MODELS_PATH"

    # Execute the mount command
    eval "$MOUNT_COMMAND" || {
        echo "WARNING: Mount command failed, continuing without mount"
    }

    # Verify mount succeeded (optional, may not always be a mount point)
    if mountpoint -q "$MODELS_PATH" 2>/dev/null; then
        echo "Storage successfully mounted at $MODELS_PATH"
    else
        echo "Note: $MODELS_PATH is not a mount point (might be local storage)"
    fi
fi

# --- Model storage setup ------------------------------------------------------
echo ""
echo "=== Setting up model storage ==="
echo "Storage path: $MODELS_PATH"

# Check if the path exists and is writable
if [ ! -d "$MODELS_PATH" ]; then
    echo "Creating model storage directory: $MODELS_PATH"
    mkdir -p "$MODELS_PATH"
fi

if [ ! -w "$MODELS_PATH" ]; then
    echo "ERROR: Model storage path is not writable: $MODELS_PATH"
    echo "Please check permissions"
    exit 1
fi

# Create the huggingface cache directory structure in the models path
mkdir -p "${MODELS_PATH}/huggingface/hub"

# Remove any existing cache directory or symlink
if [ -e ~/.cache/huggingface ] || [ -L ~/.cache/huggingface ]; then
    echo "Removing existing ~/.cache/huggingface..."
    rm -rf ~/.cache/huggingface 2>/dev/null || true
fi

# Create parent directory if needed
mkdir -p ~/.cache

# Create symlink from ~/.cache/huggingface to the models path
ln -s "${MODELS_PATH}/huggingface" ~/.cache/huggingface
echo "Created symlink: ~/.cache/huggingface -> ${MODELS_PATH}/huggingface"

# Verify the symlink works
if [ -d ~/.cache/huggingface/hub ]; then
    echo "✓ Model storage configured successfully"

    # Check available space
    AVAILABLE_SPACE=$(df -h "$MODELS_PATH" | awk 'NR==2 {print $4}')
    echo "Available space: $AVAILABLE_SPACE"
else
    echo "ERROR: Could not verify model storage setup"
    echo "The symlink was created but the target directory is not accessible"
    exit 1
fi

# --- Configure environment ----------------------------------------------------
mkdir -p ~/.config/vllm
touch ~/.config/vllm/do_not_track

# Write environment to .bashrc for persistence
cat >> ~/.bashrc << EOF

# Pi vLLM environment
[ -d "\$HOME/venv" ] && source "\$HOME/venv/bin/activate"
export PATH="/usr/local/cuda-${DRIVER_CUDA_VERSION}/bin:\$HOME/.local/bin:\$PATH"
export LD_LIBRARY_PATH="/usr/local/cuda-${DRIVER_CUDA_VERSION}/lib64:\${LD_LIBRARY_PATH:-}"
export HF_TOKEN="${HF_TOKEN}"
export MU_API_KEY="${MU_API_KEY}"
export HUGGING_FACE_HUB_TOKEN="${HF_TOKEN}"
export HF_HUB_ENABLE_HF_TRANSFER=1
export VLLM_NO_USAGE_STATS=1
export VLLM_DO_NOT_TRACK=1
export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
EOF

# Create log directory for vLLM
mkdir -p ~/.vllm_logs

# --- Output GPU info for mu CLI to parse -------------------------------------
echo ""
echo "===GPU_INFO_START==="
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader | while IFS=, read -r id name memory; do
    # Trim whitespace
    id=$(echo "$id" | xargs)
    name=$(echo "$name" | xargs)
    memory=$(echo "$memory" | xargs)
    echo "{\"id\": $id, \"name\": \"$name\", \"memory\": \"$memory\"}"
done
echo "===GPU_INFO_END==="

echo ""
echo "=== Setup complete ==="
echo "Pod is ready for vLLM deployments"
echo "Models will be cached at: $MODELS_PATH"
# Rewind intel service (FastAPI). Reads Postgres read-only.
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/app/.hf

# CPU-only torch first: the default Linux wheel pulls in several GB of CUDA
# libraries this service never uses. sentence-transformers then finds torch
# already installed and keeps it.
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install -r requirements.txt

# Download the embedding model now, so a new container starts without
# fetching ~90 MB, then forbid any download at run time.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2', device='cpu')"
ENV HF_HUB_OFFLINE=1

COPY *.py ./
EXPOSE 8000
# 0.0.0.0: accept connections from outside the container, not just inside it.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

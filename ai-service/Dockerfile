FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY requirements-ocr.txt .
RUN pip install --no-cache-dir -r requirements-ocr.txt \
    && pip install --no-cache-dir --no-deps paddleocr==3.7.0 paddlex==3.7.0
COPY requirements-models.txt .
RUN pip install --no-cache-dir -r requirements-models.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY app ./app
COPY scripts ./scripts

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

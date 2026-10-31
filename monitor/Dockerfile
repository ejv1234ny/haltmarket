FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir httpx feedparser python-dotenv

# httpx is required by main.py; feedparser and python-dotenv are also direct deps.
# Install everything from requirements.txt for completeness.
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080
CMD ["python", "main.py"]

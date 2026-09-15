FROM node:20-slim

WORKDIR /app

# Install bun since the project uses it
RUN npm install -g bun

COPY package.json package-lock.json* bun.lockb* bun.lock* ./
RUN bun install

COPY . .

EXPOSE 5173

CMD ["bun", "run", "dev", "--host"]

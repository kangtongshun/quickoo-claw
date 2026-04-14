# Dockerfile - 修改后的版本
FROM node:22-slim
# 替换APT源为阿里云
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list && \
    sed -i 's/security.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list
# 安装 Chromium 依赖
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 检查是否有 package-lock.json，没有则使用 npm install
RUN if [ -f package-lock.json ]; then \
        npm ci --only=production --omit=dev || true; \
    else \
        npm install --only=production; \
    fi && \
    npm cache clean --force

# 创建必要的目录
RUN mkdir -p /app/data /app/screenshots /app/logs

# 复制应用代码
COPY . .

# 创建非 root 用户运行
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && chown -R pptruser:pptruser /app

USER pptruser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

CMD ["node", "server.js"]

FROM node:20-alpine

WORKDIR /app

# 依存関係を先に入れてキャッシュを効かせる
COPY package.json package-lock.json ./
RUN npm ci

# アプリ本体
COPY . .

# デフォルトは本番起動（compose側で dev に上書きする）
CMD ["npm", "run", "start"]

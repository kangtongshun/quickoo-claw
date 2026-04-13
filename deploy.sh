# deploy.sh - 在服务器上手动部署的脚本
#!/bin/bash

# 设置变量
APP_NAME="crawler-service"
APP_DIR="/opt/$APP_NAME"
GIT_REPO="https://github.com/yourusername/your-repo.git"
BRANCH="main"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${GREEN}开始部署 $APP_NAME...${NC}"

# 创建应用目录
if [ ! -d "$APP_DIR" ]; then
    echo "创建应用目录: $APP_DIR"
    sudo mkdir -p $APP_DIR
    sudo chown $USER:$USER $APP_DIR
fi

# 克隆或更新代码
if [ -d "$APP_DIR/.git" ]; then
    echo "更新代码..."
    cd $APP_DIR
    git pull origin $BRANCH
else
    echo "克隆代码..."
    git clone $GIT_REPO $APP_DIR
    cd $APP_DIR
fi

# 创建必要目录
mkdir -p $APP_DIR/data
mkdir -p $APP_DIR/screenshots
mkdir -p $APP_DIR/logs

# 创建配置文件（如果不存在）
if [ ! -f "$APP_DIR/config.json" ]; then
    echo "创建默认配置文件..."
    cat > $APP_DIR/config.json << EOF
{
    "crawler": {
        "headless": true,
        "maxRetries": 3,
        "timeout": 30000
    },
    "port": 3000
}
EOF
fi

# 停止并删除旧容器
echo "停止旧容器..."
docker-compose down 2>/dev/null

# 构建并启动新容器
echo "构建并启动容器..."
docker-compose up -d --build

# 等待服务启动
sleep 5

# 检查服务状态
if curl -s http://localhost:3000/health > /dev/null; then
    echo -e "${GREEN}✓ 部署成功！服务运行正常${NC}"
    docker-compose ps
else
    echo -e "${RED}✗ 部署失败，服务未响应${NC}"
    docker-compose logs --tail=50
    exit 1
fi

# 清理旧镜像
docker system prune -f

echo -e "${GREEN}部署完成！${NC}"
echo "访问地址: http://$(curl -s ifconfig.me):3000"

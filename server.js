// server.js
const express = require('express');
const ProductCrawler = require('./product-crawler');
const AdvancedCrawler = require('./advanced-crawler');

const app = express();
app.use(express.json());
const allTasks = {}; // 用 taskId 作为 key

// 爬虫任务队列
const taskQueue = [];
let isProcessing = false;

/**
 * 提交爬虫任务
 */
app.post('/api/scrape', async (req, res) => {
    const { url, type, config } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    const taskId = Date.now().toString();
    const task = {
        id: taskId,
        url,
        type: type || 'basic',
        config: config || {},
        status: 'pending',
        createdAt: new Date()
    }
    allTasks[taskId] = task;
    taskQueue.push();
    
    // 启动任务处理
    processQueue();
    
    res.json({ 
        taskId, 
        status: 'pending',
        message: 'Task submitted successfully' 
    });
});

/**
 * 查询任务状态和结果
 */
app.get('/api/task/:taskId', async (req, res) => {
    let task = taskQueue.find(t => t.id === req.params.taskId);
    if (!task) {
        task = allTasks[req.params.taskId];
    }
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    res.json({
        id: task.id,
        status: task.status,
        result: task.result,
        error: task.error,
        createdAt: task.createdAt,
        completedAt: task.completedAt
    });
});

/**
 * 产品爬虫专用接口
 */
app.post('/api/scrape/products', async (req, res) => {
    const { url, productSelector, titleSelector, priceSelector } = req.body;
    
    if (!url || !productSelector) {
        return res.status(400).json({ error: 'URL and productSelector are required' });
    }
    
    const crawler = new ProductCrawler({ headless: true });
    
    try {
        const products = await crawler.scrapeProductList(url, {
            productSelector: productSelector,
            titleSelector: titleSelector,
            priceSelector: priceSelector,
            baseUrl: new URL(url).origin
        });
        
        await crawler.close();
        
        res.json({
            success: true,
            total: products.length,
            products: products
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * 处理任务队列
 */
async function processQueue() {
    if (isProcessing || taskQueue.length === 0) return;
    
    isProcessing = true;
    
    while (taskQueue.length > 0) {
        const task = taskQueue.shift();
        task.status = 'processing';
        
        try {
            const result = await executeTask(task);
            task.status = 'completed';
            task.result = result;
            task.completedAt = new Date();
        } catch (error) {
            task.status = 'failed';
            task.error = error.message;
            task.completedAt = new Date();
        }
    }
    
    isProcessing = false;
}

/**
 * 执行具体爬虫任务
 */
async function executeTask(task) {
    const crawler = new AdvancedCrawler({ headless: true });
    
    try {
        const result = await crawler.scrapeWithRetry(task.url, {
            waitUntil: 'networkidle2',
            extractScript: task.config.extractScript ? eval(task.config.extractScript) : null
        });
        
        await crawler.close();
        return result;
        
    } catch (error) {
        await crawler.close();
        throw error;
    }
}

// 健康检查
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        queueLength: taskQueue.length,
        timestamp: new Date()
    });
});

// 启动服务
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Crawler service running on port ${PORT}`);
});

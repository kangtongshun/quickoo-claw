// server.js
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ProductCrawler = require('./product-crawler');
const AdvancedCrawler = require('./advanced-crawler');

// 加载环境变量（优先级：系统环境变量 > .env 文件）
require('dotenv').config();

const app = express();
app.use(express.json());

// ==================== 配置加载 ====================
const config = {
    // PaddleOCR 配置
    paddleocr: {
        jobUrl: process.env.PADDLEOCR_JOB_URL || "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
        token: process.env.PADDLEOCR_TOKEN,
        model: process.env.PADDLEOCR_MODEL || "PaddleOCR-VL-1.5"
    },
    // 服务配置
    server: {
        port: process.env.PORT || 3000,
        uploadLimit: parseInt(process.env.UPLOAD_LIMIT) || 50 * 1024 * 1024 // 50MB
    }
};

// 验证必需的配置
if (!config.paddleocr.token) {
    console.error('❌ 错误: PADDLEOCR_TOKEN 环境变量未设置');
    console.error('请在 .env 文件中设置 PADDLEOCR_TOKEN 或在 GitHub Secrets 中配置');
    console.error('示例: PADDLEOCR_TOKEN=your_token_here');
    process.exit(1);
}

console.log('✓ 配置加载成功');
console.log(`  PaddleOCR Token: ${config.paddleocr.token.substring(0, 10)}...`);
console.log(`  PaddleOCR Model: ${config.paddleocr.model}`);
console.log(`  服务端口: ${config.server.port}`);
console.log(`  上传限制: ${config.server.uploadLimit / 1024 / 1024}MB`);

// ==================== 爬虫相关 ====================
const allTasks = {};
const taskQueue = [];
let isProcessing = false;

// ==================== OCR 相关配置 ====================
const JOB_URL = config.paddleocr.jobUrl;
const TOKEN = config.paddleocr.token;
const MODEL = config.paddleocr.model;

// 存储 OCR 任务信息
const ocrTasks = new Map();

// 创建上传目录
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 配置 multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: config.server.uploadLimit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的文件类型，请上传图片或PDF文件'));
        }
    }
});

// ==================== OCR 辅助函数 ====================
async function submitOCRTask(filePath, isUrl = false, optionalPayload = {}) {
    const headers = {
        "Authorization": `bearer ${TOKEN}`
    };
    
    let response;
    
    if (isUrl) {
        headers["Content-Type"] = "application/json";
        const payload = {
            fileUrl: filePath,
            model: MODEL,
            optionalPayload: {
                useDocOrientationClassify: false,
                useDocUnwarping: false,
                useChartRecognition: false,
                ...optionalPayload
            }
        };
        response = await axios.post(JOB_URL, payload, { headers });
    } else {
        const formData = new FormData();
        formData.append("model", MODEL);
        formData.append("optionalPayload", JSON.stringify({
            useDocOrientationClassify: false,
            useDocUnwarping: false,
            useChartRecognition: false,
            ...optionalPayload
        }));
        formData.append("file", fs.createReadStream(filePath));
        
        const formHeaders = {
            ...headers,
            ...formData.getHeaders()
        };
        
        response = await axios.post(JOB_URL, formData, { headers: formHeaders });
    }
    
    if (response.status !== 200) {
        throw new Error(`提交任务失败: ${response.status}`);
    }
    
    return response.data.data.jobId;
}

async function getJobStatus(jobId) {
    const response = await axios.get(`${JOB_URL}/${jobId}`, {
        headers: { "Authorization": `bearer ${TOKEN}` }
    });
    
    if (response.status !== 200) {
        throw new Error(`查询失败: ${response.status}`);
    }
    
    const data = response.data.data;
    const result = {
        jobId: data.jobId,
        state: data.state,
        progress: null,
        resultUrl: null,
        errorMsg: null
    };
    
    if (data.state === 'running' || data.state === 'done') {
        if (data.extractProgress) {
            result.progress = {
                totalPages: data.extractProgress.totalPages,
                extractedPages: data.extractProgress.extractedPages,
                startTime: data.extractProgress.startTime,
                endTime: data.extractProgress.endTime
            };
        }
    }
    
    if (data.state === 'done' && data.resultUrl) {
        result.resultUrl = {
            jsonUrl: data.resultUrl.jsonUrl,
            imageUrl: data.resultUrl.imageUrl,
            mdUrl: data.resultUrl.mdUrl
        };
    }
    
    if (data.state === 'failed') {
        result.errorMsg = data.errorMsg;
    }
    
    return result;
}

async function getFullResult(jsonlUrl) {
    const response = await axios.get(jsonlUrl);
    const lines = response.data.trim().split('\n');
    const results = [];
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        
        const parsed = JSON.parse(trimmedLine);
        results.push(parsed.result);
    }
    
    return results;
}

// ==================== 爬虫函数 ====================
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
        allTasks[task.id] = task;
    }
    
    isProcessing = false;
}

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

// ==================== API 路由 ====================

// 健康检查
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        config: {
            paddleocrConfigured: !!TOKEN,
            uploadLimit: config.server.uploadLimit,
            model: MODEL
        },
        crawlerQueueLength: taskQueue.length,
        ocrTasksCount: ocrTasks.size,
        timestamp: new Date()
    });
});

// 配置信息接口（不返回敏感信息）
app.get('/config', (req, res) => {
    res.json({
        paddleocr: {
            configured: !!TOKEN,
            model: MODEL,
            jobUrl: JOB_URL
        },
        server: {
            uploadLimit: config.server.uploadLimit,
            port: config.server.port
        }
    });
});

// ==================== 爬虫接口 ====================

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
    };
    allTasks[taskId] = task;
    taskQueue.push(task);
    
    processQueue();
    
    res.json({ 
        taskId, 
        status: 'pending',
        message: 'Task submitted successfully' 
    });
});

/**
 * 查询爬虫任务状态和结果
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

// ==================== OCR 接口 ====================

/**
 * 上传文件进行OCR识别
 */
app.post('/ocr/upload', upload.single('file'), async (req, res) => {
    let uploadedFilePath = null;
    const taskId = uuidv4();
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传文件' });
        }
        
        uploadedFilePath = req.file.path;
        
        console.log(`[OCR] 收到请求，任务ID: ${taskId}, 文件: ${req.file.originalname}`);
        
        const optionalPayload = req.body.options ? JSON.parse(req.body.options) : {};
        const jobId = await submitOCRTask(uploadedFilePath, false, optionalPayload);
        
        ocrTasks.set(taskId, {
            taskId,
            jobId,
            originalFile: req.file.originalname,
            createdAt: Date.now(),
            status: 'submitted'
        });
        
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
            fs.unlinkSync(uploadedFilePath);
        }
        
        res.json({
            success: true,
            taskId: taskId,
            jobId: jobId,
            message: 'OCR任务已提交，请使用 taskId 查询结果'
        });
        
    } catch (error) {
        console.error('[OCR] 提交失败:', error);
        
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
            try {
                fs.unlinkSync(uploadedFilePath);
            } catch (err) {
                console.error('清理临时文件失败:', err);
            }
        }
        
        res.status(500).json({
            success: false,
            error: error.message || '提交失败'
        });
    }
});

/**
 * 使用URL进行OCR识别
 */
app.post('/ocr/url', express.json(), async (req, res) => {
    const taskId = uuidv4();
    
    try {
        const { url, options } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: '请提供文件URL' });
        }
        
        console.log(`[OCR] 收到URL请求，任务ID: ${taskId}, URL: ${url}`);
        
        const jobId = await submitOCRTask(url, true, options || {});
        
        ocrTasks.set(taskId, {
            taskId,
            jobId,
            originalUrl: url,
            createdAt: Date.now(),
            status: 'submitted'
        });
        
        res.json({
            success: true,
            taskId: taskId,
            jobId: jobId,
            message: 'OCR任务已提交，请使用 taskId 查询结果'
        });
        
    } catch (error) {
        console.error('[OCR] 提交失败:', error);
        res.status(500).json({
            success: false,
            error: error.message || '提交失败'
        });
    }
});

/**
 * 查询OCR任务状态
 */
app.get('/ocr/status/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const task = ocrTasks.get(taskId);
        
        if (!task) {
            return res.status(404).json({ error: 'OCR任务不存在' });
        }
        
        const status = await getJobStatus(task.jobId);
        
        task.status = status.state;
        task.lastCheck = Date.now();
        if (status.progress) {
            task.progress = status.progress;
        }
        if (status.errorMsg) {
            task.errorMsg = status.errorMsg;
        }
        
        ocrTasks.set(taskId, task);
        
        res.json({
            taskId: task.taskId,
            jobId: task.jobId,
            state: status.state,
            progress: status.progress,
            errorMsg: status.errorMsg,
            resultUrl: status.resultUrl,
            createdAt: task.createdAt
        });
        
    } catch (error) {
        console.error('[OCR] 查询失败:', error);
        res.status(500).json({
            error: error.message || '查询失败'
        });
    }
});

/**
 * 获取完整OCR结果
 */
app.get('/ocr/result/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const task = ocrTasks.get(taskId);
        
        if (!task) {
            return res.status(404).json({ error: 'OCR任务不存在' });
        }
        
        const status = await getJobStatus(task.jobId);
        
        if (status.state !== 'done') {
            return res.json({
                taskId: task.taskId,
                state: status.state,
                message: status.state === 'pending' ? '任务排队中' : 
                        status.state === 'running' ? '任务处理中' :
                        status.state === 'failed' ? '任务失败' : '未知状态',
                progress: status.progress,
                errorMsg: status.errorMsg
            });
        }
        
        const results = await getFullResult(status.resultUrl.jsonUrl);
        
        res.json({
            taskId: task.taskId,
            state: 'done',
            results: results
        });
        
    } catch (error) {
        console.error('[OCR] 获取结果失败:', error);
        res.status(500).json({
            error: error.message || '获取结果失败'
        });
    }
});

/**
 * 列出所有OCR任务
 */
app.get('/ocr/tasks', (req, res) => {
    const taskList = Array.from(ocrTasks.values()).map(task => ({
        taskId: task.taskId,
        jobId: task.jobId,
        status: task.status,
        createdAt: task.createdAt,
        originalFile: task.originalFile,
        originalUrl: task.originalUrl
    }));
    
    res.json({
        total: taskList.length,
        tasks: taskList
    });
});

/**
 * 删除OCR任务记录
 */
app.delete('/ocr/task/:taskId', (req, res) => {
    const { taskId } = req.params;
    
    if (!ocrTasks.has(taskId)) {
        return res.status(404).json({ error: 'OCR任务不存在' });
    }
    
    ocrTasks.delete(taskId);
    res.json({ success: true, message: 'OCR任务已删除' });
});

// ==================== 错误处理中间件 ====================
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'FILE_TOO_LARGE') {
            return res.status(400).json({ error: `文件过大，最大支持${config.server.uploadLimit / 1024 / 1024}MB` });
        }
        return res.status(400).json({ error: err.message });
    }
    console.error('[Server] 错误:', err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
});

// 启动服务
const PORT = config.server.port;
app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`\n📋 配置状态:`);
    console.log(`  PaddleOCR Token: ${TOKEN ? '✓ 已配置' : '✗ 未配置'}`);
    console.log(`  PaddleOCR Model: ${MODEL}`);
    console.log(`  上传限制: ${config.server.uploadLimit / 1024 / 1024}MB`);
    console.log(`\n🔧 爬虫接口:`);
    console.log(`  POST   /api/scrape           - 提交爬虫任务`);
    console.log(`  GET    /api/task/:taskId     - 查询爬虫任务`);
    console.log(`  POST   /api/scrape/products  - 产品爬虫`);
    console.log(`\n📝 OCR接口:`);
    console.log(`  POST   /ocr/upload           - 上传文件识别`);
    console.log(`  POST   /ocr/url              - URL识别`);
    console.log(`  GET    /ocr/status/:taskId   - 查询OCR状态`);
    console.log(`  GET    /ocr/result/:taskId   - 获取OCR结果`);
    console.log(`  GET    /ocr/tasks            - 列出OCR任务`);
    console.log(`  DELETE /ocr/task/:taskId     - 删除OCR任务`);
    console.log(`\n✅ 服务已就绪\n`);
});

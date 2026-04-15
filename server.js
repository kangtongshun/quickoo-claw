const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// PaddleOCR API 配置
const JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const TOKEN = "e587240b3278e1a1a37bff0cf2c216a49ccd4727";
const MODEL = "PaddleOCR-VL-1.5";

// 存储任务信息（生产环境建议使用 Redis 或数据库）
const tasks = new Map();

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
        fileSize: 50 * 1024 * 1024
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

// 提交OCR任务
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

// 查询任务状态
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

// 获取完整结果（下载并解析）
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

// API 路由

// 健康检查
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 上传文件进行OCR识别
app.post('/ocr/upload', upload.single('file'), async (req, res) => {
    let uploadedFilePath = null;
    const taskId = uuidv4();
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传文件' });
        }
        
        uploadedFilePath = req.file.path;
        
        console.log(`收到OCR请求，任务ID: ${taskId}, 文件: ${req.file.originalname}`);
        
        // 解析可选参数
        const optionalPayload = req.body.options ? JSON.parse(req.body.options) : {};
        
        // 提交OCR任务
        const jobId = await submitOCRTask(uploadedFilePath, false, optionalPayload);
        
        // 存储任务信息
        tasks.set(taskId, {
            taskId,
            jobId,
            originalFile: req.file.originalname,
            createdAt: Date.now(),
            status: 'submitted'
        });
        
        // 清理临时文件
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
            fs.unlinkSync(uploadedFilePath);
        }
        
        res.json({
            success: true,
            taskId: taskId,
            jobId: jobId,
            message: '任务已提交，请使用 taskId 查询结果'
        });
        
    } catch (error) {
        console.error('提交失败:', error);
        
        // 清理临时文件
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

// 使用URL进行OCR识别
app.post('/ocr/url', express.json(), async (req, res) => {
    const taskId = uuidv4();
    
    try {
        const { url, options } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: '请提供文件URL' });
        }
        
        console.log(`收到OCR URL请求，任务ID: ${taskId}, URL: ${url}`);
        
        // 提交OCR任务
        const jobId = await submitOCRTask(url, true, options || {});
        
        // 存储任务信息
        tasks.set(taskId, {
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
            message: '任务已提交，请使用 taskId 查询结果'
        });
        
    } catch (error) {
        console.error('提交失败:', error);
        res.status(500).json({
            success: false,
            error: error.message || '提交失败'
        });
    }
});

// 查询任务状态（简化版）
app.get('/ocr/status/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const task = tasks.get(taskId);
        
        if (!task) {
            return res.status(404).json({ error: '任务不存在' });
        }
        
        // 查询 PaddleOCR 任务状态
        const status = await getJobStatus(task.jobId);
        
        // 更新存储的状态
        task.status = status.state;
        task.lastCheck = Date.now();
        if (status.progress) {
            task.progress = status.progress;
        }
        if (status.errorMsg) {
            task.errorMsg = status.errorMsg;
        }
        
        tasks.set(taskId, task);
        
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
        console.error('查询失败:', error);
        res.status(500).json({
            error: error.message || '查询失败'
        });
    }
});

// 获取完整OCR结果
app.get('/ocr/result/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const task = tasks.get(taskId);
        
        if (!task) {
            return res.status(404).json({ error: '任务不存在' });
        }
        
        // 先查询状态
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
        
        // 获取完整结果
        const results = await getFullResult(status.resultUrl.jsonUrl);
        
        res.json({
            taskId: task.taskId,
            state: 'done',
            results: results
        });
        
    } catch (error) {
        console.error('获取结果失败:', error);
        res.status(500).json({
            error: error.message || '获取结果失败'
        });
    }
});

// 列出所有任务
app.get('/ocr/tasks', (req, res) => {
    const taskList = Array.from(tasks.values()).map(task => ({
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

// 删除任务记录
app.delete('/ocr/task/:taskId', (req, res) => {
    const { taskId } = req.params;
    
    if (!tasks.has(taskId)) {
        return res.status(404).json({ error: '任务不存在' });
    }
    
    tasks.delete(taskId);
    res.json({ success: true, message: '任务已删除' });
});

// 错误处理中间件
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'FILE_TOO_LARGE') {
            return res.status(400).json({ error: '文件过大，最大支持50MB' });
        }
        return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`OCR服务已启动: http://localhost:${PORT}`);
    console.log(`上传目录: ${uploadDir}`);
    console.log(`API 接口:`);
    console.log(`  POST   /ocr/upload      - 上传文件识别`);
    console.log(`  POST   /ocr/url         - URL识别`);
    console.log(`  GET    /ocr/status/:taskId - 查询状态`);
    console.log(`  GET    /ocr/result/:taskId - 获取完整结果`);
    console.log(`  GET    /ocr/tasks       - 列出所有任务`);
    console.log(`  DELETE /ocr/task/:taskId   - 删除任务`);
});

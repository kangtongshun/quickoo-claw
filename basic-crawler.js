// basic-crawler.js
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');

/**
 * 基础爬虫类
 * 提供核心的网页抓取和解析功能
 */
class BasicCrawler {
    constructor(options = {}) {
        this.headless = options.headless !== false;
        this.timeout = options.timeout || 30000;
        this.browser = null;
    }

    /**
     * 初始化浏览器实例
     */
    async initBrowser() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: this.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ]
            });
        }
        return this.browser;
    }

    /**
     * 抓取单页内容
     * @param {string} url - 目标URL
     * @param {Object} options - 抓取选项
     */
    async scrapePage(url, options = {}) {
        const browser = await this.initBrowser();
        const page = await browser.newPage();
        
        try {
            // 设置用户代理
            await page.setUserAgent(options.userAgent || this.getRandomUserAgent());
            
            // 设置视口大小
            await page.setViewport(options.viewport || { width: 1920, height: 1080 });
            
            // 导航到目标页面
            await page.goto(url, {
                waitUntil: options.waitUntil || 'networkidle2',
                timeout: options.timeout || this.timeout
            });
            
            // 等待指定选择器（如果提供）
            if (options.waitForSelector) {
                await page.waitForSelector(options.waitForSelector, { timeout: this.timeout });
            }
            
            // 执行滚动（如果需要加载懒加载内容）
            if (options.scrollToBottom) {
                await this.autoScroll(page);
            }
            
            // 获取页面内容
            const html = await page.content();
            
            // 截图（可选）
            if options.screenshot) {
                await page.screenshot({ path: `screenshots/${Date.now()}.png` });
            }
            
            return { url, html, success: true };
            
        } catch (error) {
            console.error(`Failed to scrape ${url}:`, error.message);
            return { url, error: error.message, success: false };
            
        } finally {
            await page.close();
        }
    }

    /**
     * 自动滚动页面（处理懒加载）
     */
    async autoScroll(page) {
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    
                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 200);
            });
        });
    }

    /**
     * 解析HTML提取数据
     * @param {string} html - HTML内容
     * @param {Object} selectors - CSS选择器配置
     */
    parseHTML(html, selectors) {
        const $ = cheerio.load(html);
        const results = [];
        
        // 如果提供了列表容器选择器，遍历每个项目
        if (selectors.container) {
            $(selectors.container).each((index, element) => {
                const item = {};
                
                for (const [key, selector] of Object.entries(selectors.fields)) {
                    if (typeof selector === 'string') {
                        item[key] = $(element).find(selector).text().trim();
                    } else if (selector.attr) {
                        item[key] = $(element).find(selector.selector).attr(selector.attr);
                    }
                }
                
                results.push(item);
            });
        } else {
            // 单页数据提取
            for (const [key, selector] of Object.entries(selectors.fields)) {
                if (typeof selector === 'string') {
                    results[key] = $(selector).text().trim();
                } else if (selector.attr) {
                    results[key] = $(selector.selector).attr(selector.attr);
                }
            }
        }
        
        return results;
    }

    /**
     * 随机User-Agent
     */
    getRandomUserAgent() {
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0'
        ];
        return userAgents[Math.floor(Math.random() * userAgents.length)];
    }

    /**
     * 关闭浏览器
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

// 导出模块
module.exports = BasicCrawler;

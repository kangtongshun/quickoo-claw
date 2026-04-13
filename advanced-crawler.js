// advanced-crawler.js
const puppeteer = require('puppeteer');
const fs = require('fs');

class AdvancedCrawler {
    constructor(config = {}) {
        this.config = {
            headless: config.headless ?? true,
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 2000,
            proxyList: config.proxyList || [],
            currentProxyIndex: 0
        };
        this.browser = null;
    }

    /**
     * 启动浏览器（支持代理）
     */
    async launchBrowser() {
        const args = ['--no-sandbox', '--disable-setuid-sandbox'];
        
        // 配置代理
        if (this.config.proxyList.length > 0) {
            const proxy = this.getNextProxy();
            args.push(`--proxy-server=${proxy}`);
        }
        
        this.browser = await puppeteer.launch({
            headless: this.config.headless,
            args: args
        });
        
        return this.browser;
    }

    /**
     * 轮换代理
     */
    getNextProxy() {
        const proxy = this.config.proxyList[this.config.currentProxyIndex];
        this.config.currentProxyIndex = (this.config.currentProxyIndex + 1) % this.config.proxyList.length;
        return proxy;
    }

    /**
     * 带重试机制的页面抓取
     */
    async scrapeWithRetry(url, options = {}) {
        let lastError = null;
        
        for (let i = 0; i < this.config.maxRetries; i++) {
            try {
                return await this.scrapePage(url, options);
            } catch (error) {
                lastError = error;
                console.log(`抓取失败 (尝试 ${i + 1}/${this.config.maxRetries}): ${error.message}`);
                
                if (i < this.config.maxRetries - 1) {
                    await this.delay(this.config.retryDelay * (i + 1));
                    // 重试时切换代理
                    if (this.config.proxyList.length > 0) {
                        await this.reconnectWithNewProxy();
                    }
                }
            }
        }
        
        throw lastError;
    }

    /**
     * 重新连接新代理
     */
    async reconnectWithNewProxy() {
        if (this.browser) {
            await this.browser.close();
        }
        await this.launchBrowser();
    }

    /**
     * 抓取页面
     */
    async scrapePage(url, options = {}) {
        if (!this.browser) {
            await this.launchBrowser();
        }
        
        const page = await this.browser.newPage();
        
        try {
            // 设置请求拦截（可选）
            if (options.blockImages) {
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    if (request.resourceType() === 'image') {
                        request.abort();
                    } else {
                        request.continue();
                    }
                });
            }
            
            // 设置额外头部
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br'
            });
            
            await page.setUserAgent(this.getRandomUserAgent());
            
            // 导航
            await page.goto(url, {
                waitUntil: options.waitUntil || 'networkidle2',
                timeout: options.timeout || 30000
            });
            
            // 等待指定元素
            if (options.waitForSelector) {
                await page.waitForSelector(options.waitForSelector, { timeout: 10000 });
            }
            
            // 执行自定义脚本
            let data = null;
            if (options.extractScript) {
                data = await page.evaluate(options.extractScript);
            } else {
                data = await page.content();
            }
            
            return { success: true, data, url };
            
        } finally {
            await page.close();
        }
    }

    /**
     * 模拟登录
     */
    async login(loginUrl, credentials, selectors) {
        const page = await this.browser.newPage();
        
        try {
            await page.goto(loginUrl, { waitUntil: 'networkidle2' });
            
            // 输入用户名和密码
            await page.type(selectors.username, credentials.username);
            await page.type(selectors.password, credentials.password);
            
            // 点击登录按钮
            await page.click(selectors.submitButton);
            
            // 等待登录完成
            await page.waitForNavigation({ waitUntil: 'networkidle2' });
            
            // 保存cookies
            const cookies = await page.cookies();
            fs.writeFileSync('cookies.json', JSON.stringify(cookies));
            
            console.log('登录成功');
            return true;
            
        } catch (error) {
            console.error('登录失败:', error);
            return false;
            
        } finally {
            await page.close();
        }
    }

    /**
     * 加载保存的cookies
     */
    async loadCookies() {
        try {
            const cookiesString = fs.readFileSync('cookies.json');
            const cookies = JSON.parse(cookiesString);
            
            const page = await this.browser.newPage();
            await page.setCookie(...cookies);
            await page.close();
            
            return true;
        } catch (error) {
            return false;
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getRandomUserAgent() {
        const agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        ];
        return agents[Math.floor(Math.random() * agents.length)];
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

module.exports = AdvancedCrawler;

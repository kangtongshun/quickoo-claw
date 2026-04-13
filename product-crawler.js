// product-crawler.js
const BasicCrawler = require('./basic-crawler');

class ProductCrawler extends BasicCrawler {
    constructor(options = {}) {
        super(options);
        this.products = [];
    }

    /**
     * 爬取产品列表
     * @param {string} url - 产品列表页URL
     * @param {Object} config - 爬取配置
     */
    async scrapeProductList(url, config) {
        console.log(`开始爬取产品列表: ${url}`);
        
        const result = await this.scrapePage(url, {
            waitForSelector: config.productSelector,
            scrollToBottom: true
        });
        
        if (result.success) {
            const products = this.parseHTML(result.html, {
                container: config.productSelector,
                fields: {
                    title: config.titleSelector || 'h3, .product-title',
                    price: config.priceSelector || '.price',
                    image: {
                        selector: 'img',
                        attr: 'src'
                    },
                    link: {
                        selector: 'a',
                        attr: 'href'
                    },
                    description: config.descSelector || '.description'
                }
            });
            
            this.products.push(...products);
            console.log(`成功提取 ${products.length} 个产品`);
            
            // 如果有分页，继续爬取
            if (config.paginationSelector && result.html) {
                await this.handlePagination(result.html, config);
            }
            
            return this.products;
        }
        
        return [];
    }

    /**
     * 处理分页
     */
    async handlePagination(html, config) {
        const $ = require('cheerio').load(html);
        const nextPageUrl = $(config.paginationSelector).attr('href');
        
        if (nextPageUrl && nextPageUrl !== '#') {
            const fullUrl = new URL(nextPageUrl, config.baseUrl).href;
            console.log(`爬取下一页: ${fullUrl}`);
            await this.scrapeProductList(fullUrl, config);
        }
    }

    /**
     * 爬取产品详情
     * @param {string} url - 产品详情页URL
     * @param {Object} selectors - 选择器配置
     */
    async scrapeProductDetail(url, selectors) {
        console.log(`爬取产品详情: ${url}`);
        
        const result = await this.scrapePage(url, {
            waitForSelector: selectors.title
        });
        
        if (result.success) {
            const detail = this.parseHTML(result.html, {
                fields: {
                    title: selectors.title,
                    price: selectors.price,
                    description: selectors.description,
                    specifications: selectors.specifications,
                    availability: selectors.availability,
                    rating: selectors.rating,
                    reviews: selectors.reviews
                }
            });
            
            return { url, ...detail };
        }
        
        return null;
    }

    /**
     * 保存数据到JSON文件
     */
    saveToFile(filename = 'products.json') {
        const fs = require('fs');
        fs.writeFileSync(filename, JSON.stringify(this.products, null, 2));
        console.log(`数据已保存到 ${filename}`);
    }
}

module.exports = ProductCrawler;

import cluster from 'cluster'
import { Page } from 'rebrowser-playwright'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtil from './browser/BrowserUtil'

import { log } from './util/Logger'
import Util from './util/Utils'
import { loadAccounts, loadConfig, saveSessionData } from './util/Load'

import { Login } from './functions/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'

import { Account } from './interface/Account'
import Axios from './util/Axios'
import { LogTimeoutMonitor } from './util/LogTimeoutMonitor';
import { setLogMonitor } from './util/Logger';

// Main bot class
export class MicrosoftRewardsBot {
    public log: typeof log
    public config
    public utils: Util
    public activities: Activities = new Activities(this)
    public browser: {
        func: BrowserFunc,
        utils: BrowserUtil
    }
    public isMobile: boolean
    public homePage!: Page

    private pointsCanCollect: number = 0
    private pointsInitial: number = 0

    private activeWorkers: number
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private workers: Workers
    private login = new Login(this)
    private accessToken: string = ''

    //@ts-expect-error Will be initialized later
    public axios: Axios

    constructor(isMobile: boolean) {
        this.isMobile = isMobile
        this.log = log

        this.accounts = []
        this.utils = new Util()
        this.workers = new Workers(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtil(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
    }

    async initialize() {
        this.accounts = loadAccounts()
    }

    async run() {
        log('main', 'MAIN', `Bot started with ${this.config.clusters} clusters`)

        // Only cluster when there's more than 1 cluster demanded
        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                this.runMaster()
            } else {
                this.runWorker()
            }
        } else {
            await this.runTasks(this.accounts)
        }
    }

    private runMaster() {
        log('main', 'MAIN-PRIMARY', 'Primary process started')

        const accountChunks = this.utils.chunkArray(this.accounts, this.config.clusters)

        for (let i = 0; i < accountChunks.length; i++) {
            const worker = cluster.fork()
            const chunk = accountChunks[i]
            worker.send({ chunk })
        }

        cluster.on('exit', (worker: { process: { pid: any } }, code: any) => {
            this.activeWorkers -= 1

            log('main', 'MAIN-WORKER', `Worker ${worker.process.pid} destroyed | Code: ${code} | Active workers: ${this.activeWorkers}`, 'warn')

            // Check if all workers have exited
            if (this.activeWorkers === 0) {
                log('main', 'MAIN-WORKER', 'All workers destroyed. Exiting main process!', 'warn')
                process.exit(0)
            }
        })
    }

    private runWorker() {
        log('main', 'MAIN-WORKER', `Worker ${process.pid} spawned`)
        // Receive the chunk of accounts from the master
        process.on('message', async ({ chunk }) => {
            await this.runTasks(chunk)
        })
    }

    private async runTasks(accounts: Account[]) {
        for (const account of accounts) {
            log('main', 'MAIN-WORKER', `Started tasks for account ${account.email}`)

            this.axios = new Axios(account.proxy)
            if (this.config.parallel) {
                await Promise.all([
                    this.Desktop(account),
                    (() => {
                        const mobileInstance = new MicrosoftRewardsBot(true)
                        mobileInstance.axios = this.axios

                        return mobileInstance.Mobile(account)
                    })()
                ])
            } else {
                this.isMobile = false
                await this.Desktop(account)

                this.isMobile = true
                await this.Mobile(account)
            }

            log('main', 'MAIN-WORKER', `Completed tasks for account ${account.email}`, 'log', 'green')
        }

        log(this.isMobile, 'MAIN-PRIMARY', 'Completed tasks for ALL accounts', 'log', 'green')
        process.exit()
    }

    // Desktop
    async Desktop(account: Account) {
        const browser = await this.browserFactory.createBrowser(account.proxy, account.email)
        this.homePage = await browser.newPage()

        log(this.isMobile, 'MAIN', 'Starting browser')

        // Login into MS Rewards, then go to rewards homepage
        await this.login.login(this.homePage, account.email, account.password)

        await this.browser.func.goHome(this.homePage)

        const data = await this.browser.func.getDashboardData()

        this.pointsInitial = data.userStatus.availablePoints

        log(this.isMobile, 'MAIN-POINTS', `Current point count: ${this.pointsInitial}`)

        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints()

        // Tally all the desktop points
        this.pointsCanCollect = browserEnarablePoints.dailySetPoints +
            browserEnarablePoints.desktopSearchPoints
            + browserEnarablePoints.morePromotionsPoints

        log(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today`)

        // If runOnZeroPoints is false and 0 points to earn, don't continue
        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
            log(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow')

            // Close desktop browser
            await this.browser.func.closeBrowser(browser, account.email)
            // 清理引用
            this.homePage = undefined as any;
            return
        }

        // Complete daily set
        if (this.config.workers.doDailySet) {
            await this.workers.doDailySet(this.homePage, data)
        }

        // Complete more promotions
        if (this.config.workers.doMorePromotions) {
            await this.workers.doMorePromotions(this.homePage, data)
        }

        // Complete punch cards
        if (this.config.workers.doPunchCards) {
            await this.workers.doPunchCard(this.homePage, data)
        }

        // Do desktop searches
        if (this.config.workers.doDesktopSearch) {
            await this.activities.doSearch(this.homePage, data)
        }

        // Save cookies
        await saveSessionData(this.config.sessionPath, browser, account.email, this.isMobile)

        // Close desktop browser
        await this.browser.func.closeBrowser(browser, account.email)
        // 清理引用
        this.homePage = undefined as any;
        return
    }

    // Mobile
    async Mobile(account: Account) {
        let retryAttempts = 0;
        while (true) {
            const browser = await this.browserFactory.createBrowser(account.proxy, account.email)
            this.homePage = await browser.newPage()

            log(this.isMobile, 'MAIN', 'Starting browser')

            // Login into MS Rewards, then go to rewards homepage
            await this.login.login(this.homePage, account.email, account.password)
            this.accessToken = await this.login.getMobileAccessToken(this.homePage, account.email)

            await this.browser.func.goHome(this.homePage)

            const data = await this.browser.func.getDashboardData()

            const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints()
            const appEarnablePoints = await this.browser.func.getAppEarnablePoints(this.accessToken)

            this.pointsCanCollect = browserEnarablePoints.mobileSearchPoints + appEarnablePoints.totalEarnablePoints

            log(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today (Browser: ${browserEnarablePoints.mobileSearchPoints} points, App: ${appEarnablePoints.totalEarnablePoints} points)`)

            // If runOnZeroPoints is false and 0 points to earn, don't continue
            if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
                log(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow')

                // Close mobile browser
                await this.browser.func.closeBrowser(browser, account.email)
                // 清理引用
                this.homePage = undefined as any;
                this.accessToken = '';
                return
            }

            // Do daily check in
            if (this.config.workers.doDailyCheckIn) {
                await this.activities.doDailyCheckIn(this.accessToken, data)
            }

            // Do read to earn
            if (this.config.workers.doReadToEarn) {
                await this.activities.doReadToEarn(this.accessToken, data)
            }

            // Do mobile searches
            let needRetry = false;
            if (this.config.workers.doMobileSearch) {
                if (data.userStatus.counters.mobileSearch) {
                    let searchSuccess = false;
                    try {
                        await this.activities.doSearch(this.homePage, data);
                        searchSuccess = true;
                    } catch (error) {
                        searchSuccess = false;
                    }
                    
                    if (!searchSuccess) {
                        // 搜索未完成
                        const mobileSearchPoints = (await this.browser.func.getSearchPoints()).mobileSearch?.[0]

                        if (mobileSearchPoints && (mobileSearchPoints.pointProgressMax - mobileSearchPoints.pointProgress) > 0) {
                            retryAttempts++;
                            this.log(this.isMobile, 'MAIN', `Mobile search incomplete - Points remaining: ${mobileSearchPoints.pointProgressMax - mobileSearchPoints.pointProgress}`, 'warn')
                            needRetry = true;
                        }
                    } else {
                        this.log(this.isMobile, 'MAIN', 'Mobile search completed successfully')
                    }

                    if (needRetry) {
                        if (retryAttempts > this.config.searchSettings.retryMobileSearchAmount) {
                            this.log(this.isMobile, 'MAIN', `Max retry limit of ${this.config.searchSettings.retryMobileSearchAmount} reached. Exiting retry loop`, 'warn')
                            await this.browser.func.closeBrowser(browser, account.email)
                            // 清理引用
                            this.homePage = undefined as any;
                            this.accessToken = '';
                            break;
                        } else {
                            this.log(this.isMobile, 'MAIN', `Attempt ${retryAttempts}/${this.config.searchSettings.retryMobileSearchAmount}: Unable to complete mobile searches, bad User-Agent? Increase search delay? Retrying...`, 'log', 'yellow')
                            await this.browser.func.closeBrowser(browser, account.email)
                            // 清理引用
                            this.homePage = undefined as any;
                            this.accessToken = '';
                            continue;
                        }
                    }
                } else {
                    log(this.isMobile, 'MAIN', 'Unable to fetch search points, your account is most likely too "new" for this! Try again later!', 'warn')
                }
            }

            const afterPointAmount = await this.browser.func.getCurrentPoints()

            log(this.isMobile, 'MAIN-POINTS', `The script collected ${afterPointAmount - this.pointsInitial} points today`)

            // Close mobile browser
            await this.browser.func.closeBrowser(browser, account.email)
            // 清理引用
            this.homePage = undefined as any;
            this.accessToken = '';
            break;
        }
        return
    }

}

async function main() {
    const rewardsBot = new MicrosoftRewardsBot(false);
    
    // 创建并启动超时监控
    const monitor = new LogTimeoutMonitor(30);
    setLogMonitor(monitor);
    monitor.start();

    try {
        await rewardsBot.initialize();
        await rewardsBot.run();
    } catch (error) {
        // 记录错误
        log(false, 'MAIN-ERROR', `Error running desktop bot: ${error}`, 'error');
        
        // 强制结束进程，不等待其他操作
        process.kill(process.pid, 'SIGTERM');
    } finally {
        // 清理监控器
        monitor.cleanup();
    }
}

// 添加 SIGTERM 信号处理
process.on('SIGTERM', () => {
    log('main', 'SHUTDOWN', 'Process terminated. Performing emergency cleanup...', 'error');
    process.exit(1);
});

// 添加未捕获异常处理
process.on('uncaughtException', (error) => {
    log('main', 'UNCAUGHT-EXCEPTION', `Fatal error: ${error}`, 'error');
    process.kill(process.pid, 'SIGTERM');
});

// 添加未处理的 Promise 拒绝处理
process.on('unhandledRejection', (reason) => {
    log('main', 'UNHANDLED-REJECTION', `Fatal error in promise: ${reason}`, 'error');
    process.kill(process.pid, 'SIGTERM');
});

// 确保在进程退出时清理
process.on('SIGINT', () => {
    log('main', 'SHUTDOWN', 'Process interrupted. Cleaning up...', 'error');
    process.kill(process.pid, 'SIGTERM');
});

process.on('exit', (code) => {
    log('main', 'SHUTDOWN', `Process exiting with code ${code}. Final cleanup complete.`, 'error');
});

// Start the bots
main().catch(error => {
    log('main', 'MAIN-ERROR', `Fatal error running bots: ${error}`, 'error');
    process.kill(process.pid, 'SIGTERM');
});

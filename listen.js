

const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBotModule = require('node-telegram-bot-api');
// 自动兼容 CommonJS / ES Module 两种导出格式
const TelegramBot = TelegramBotModule.TelegramBot || TelegramBotModule;
const { isProcessed, markProcessed } = require('./dedup');
const {getAbsoluteTokenMetadata} = require("./getTokenName");

// =================【配置区域】=================
// 1. Telegram 机器人配置
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '7014676539:AAGg6ykS89y14B3n8jEaHFIF2pOKWckw8j8';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '-1004484163295';
// 2. RPC / WSS 节点配置（建议换成 Helius 或 QuickNode 节点）
const RPC_ENDPOINT = 'https://solana-mainnet.g.alchemy.com/v2/alch_0Qz-i69ghrz_45KqW3D47';
const WSS_ENDPOINT = 'wss://solana-mainnet.streaming.alchemy.com/v2/alch_0Qz-i69ghrz_45KqW3D47';
// ==============================================

// 初始化 Telegram 机器人
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: WSS_ENDPOINT,
  commitment: 'confirmed',
});

// 基础计价币列表
const COMMON_TOKENS = new Set([
  'So11111111111111111111111111111111111111112', // Native WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '11111111111111111111111111111111',            // System Program
]);

// 各 DEX 建池指令配置
const DEX_CONFIG = {

  'Raydium CLMM': {
    programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    strictMethods: ['createpool'],
  },
   'Orca Whirlpool (CLMM)': {
  // 1. 修正为官方正确的 Program ID
  programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 
  
  // 2. 补全可能的指令写法（包含标准 CamelCase 命名）
  strictMethods: [
    'initializePool', 
    'initializePoolV2', 
    'initializePoolV3',
    'initializepool', 
    'initializepoolv2'
  ],
},
  'Meteora DLMM': {
    programId: 'LBUZ2A2evqw2Av4nqB4PWS53D35QuBfGizpt12aBHJE',
    strictMethods: ['initializepool', 'initializecustompool'],
  },
};
/**
 * 4. 用 DexScreener API 根据代币合约查名字（包含自动重试机制）
 */
async function getTokenMetadataByMint(mintAddress) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;

  // 刚开池时 API 可能需要 1-2 秒建立索引，给予最多 3 次重试
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.get(url, { timeout: 4000 });
      if (response.data && response.data.pairs && response.data.pairs.length > 0) {
        const pair = response.data.pairs[0];

        // 判断目标代币是 baseToken 还是 quoteToken
        const isBase = pair.baseToken && pair.baseToken.address === mintAddress;
        const targetToken = isBase ? pair.baseToken : pair.quoteToken;

        if (targetToken && targetToken.name) {
          return {
            name: targetToken.name || '未知代币',
            symbol: targetToken.symbol || 'UNKNOWN',
            priceUsd: pair.priceUsd ? `$${pair.priceUsd}` : '暂无数据'
          };
        }
      }
    } catch (err) {
      console.log(`⚠️ DexScreener API 查询重试 [${attempt}/3] 失败: ${err.message}`);
    }
    // 如果第一次没拿到，等待 1.5 秒后重试
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return { name: '新代币 (索引建立中)', symbol: 'NEW', priceUsd: '未知' };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 解析交易并生成数据
async function parseNewPoolTx(signature, programIdStr, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sleep(1000 * attempt);

      const parsedTx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!parsedTx || !parsedTx.meta) continue;

      // 防重放：丢弃 90 秒以前的历史交易
      const nowUnix = Math.floor(Date.now() / 1000);
      if (parsedTx.blockTime && nowUnix - parsedTx.blockTime > 90) {
        return null;
      }

      const tokenMints = new Set();
      const postBalances = parsedTx.meta.postTokenBalances || [];

      postBalances.forEach((balance) => {
        if (balance.mint && !COMMON_TOKENS.has(balance.mint)) {
          tokenMints.add(balance.mint);
        }
      });

      let poolAddress = '待解析';
      const accountKeys = parsedTx.transaction.message.accountKeys;
      const possiblePool = accountKeys.find(
        (acc) => acc.pubkey.toBase58() !== programIdStr && acc.writable
      );
      if (possiblePool) poolAddress = possiblePool.pubkey.toBase58();

      return {
        tokenMints: Array.from(tokenMints),
        poolAddress: poolAddress,
        isFresh: true,
      };
    } catch (err) {
      if (attempt === retries) return null;
    }
  }
  return null;
}

// 发送格式化好的 Telegram 消息
async function sendTgNotification(dexName, txSignature, details) {
  const time = new Date().toLocaleTimeString();
  const tokenAddress = details.tokenMints.length > 0 ? details.tokenMints[0] : '未知/原生SOL池';
  const { name, symbol } = await getAbsoluteTokenMetadata(tokenAddress);  // HTML 格式的 Telegram 漂亮排版消息
  const message = `
🚨 <b>[${dexName}] 发现新池子上线！</b>

🪙 <b>代币名称</b>: ${name})
🏷️ <b>代币符号</b>: $${symbol}
🔑 <b>合约地址 (Mint)</b>: <code>${tokenAddress}</code>
🔗 <b>快捷链接</b>:
• <a href="https://web3.okx.com/zh-hans/token/solana/${tokenAddress}">点击Web3 OKX查看</a>
    `.trim();
  try {
    await bot.sendMessage(TG_CHAT_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    console.log(`[${time}] ✅ 已成功推送 Telegram 提醒！`);
  } catch (err) {
    console.error(`[Telegram 推送失败]:`, err.message);
  }
}

function startMonitor() {
  console.log('🚀 监听服务与 Telegram 机器人已启动...\n');

  Object.entries(DEX_CONFIG).forEach(([dexName, config]) => {
    const programId = new PublicKey(config.programId);

    connection.onLogs(
      programId,
      async (logs) => {
        if (logs.err) return;

        const logText = logs.logs.join('').toLowerCase();
        const isNewPool = config.strictMethods.some((method) => logText.includes(method));

        if (isNewPool) {
          const txSignature = logs.signature;

          if (isProcessed(txSignature)) return;
          markProcessed(txSignature);

          const time = new Date().toLocaleTimeString();

          parseNewPoolTx(txSignature, config.programId).then((details) => {
            if (!details || !details.isFresh) return;

            console.log(`[${time}] 🎉 发现新池，正在发送 TG 消息...`);
            
            // 触发 Telegram 发送
            sendTgNotification(dexName, txSignature, details);
          });
        }
      },
      'confirmed'
    );
  });
}

startMonitor();

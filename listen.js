


const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBotModule = require('node-telegram-bot-api');
// 自动兼容 CommonJS / ES Module 两种导出格式
const TelegramBot = TelegramBotModule.TelegramBot || TelegramBotModule;
const { isProcessed, markProcessed } = require('./dedup');

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
'Pump.fun (Bonding Curve)': {
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    strictMethods: ['create'], // 监听 Pump.fun 内部新币/新池创建
  },
  'Raydium CLMM': {
    programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    strictMethods: ['createpool'],
  },
  'Orca Whirlpool (CLMM)': {
    programId: 'whirLMiicVdio4qvUfM5KAgZXPacWy225a3D2WFphXi',
    strictMethods: ['initializepool', 'initializepoolv2'],
  },
  'Meteora DLMM': {
    programId: 'LBUZ2A2evqw2Av4nqB4PWS53D35QuBfGizpt12aBHJE',
    strictMethods: ['initializepool', 'initializecustompool'],
  },
};

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
  
  // HTML 格式的 Telegram 漂亮排版消息
  const caption = 
`🚀 <b>发现全新流动性池！</b>

<b>DEX 平台:</b> ${dexName}
<b>检测时间:</b> ${time}

<b>🪙 代币合约 (Mint):</b>
<code>${tokenAddress}</code>

<b>🏊 流动性池 (Pool):</b>
<code>${details.poolAddress}</code>

<b>🔗 快捷跳转链接:</b>
• <a href="https://solscan.io/tx/${txSignature}">Solscan 交易详情</a>
• <a href="https://dexscreener.com/solana/${details.poolAddress}">DexScreener K线行情</a>
• <a href="https://web3.okx.com/zh-hans/token/solana/${tokenAddress}">点击Web3 OKX查看</a>`;

  try {
    await bot.sendMessage(TG_CHAT_ID, caption, {
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

setInterval(() => {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ❤️ 监听服务与 TG 机器人正常运行中...`);
}, 30000);

startMonitor();

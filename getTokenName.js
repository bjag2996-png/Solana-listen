const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { publicKey } = require('@metaplex-foundation/umi');
const { fetchMetadata, findMetadataPda } = require('@metaplex-foundation/mpl-token-metadata');

// 初始化 Umi (使用你的 RPC 节点，推荐 Helius/QuickNode，官方节点容易限流)
const RPC_ENDPOINT = 'https://mainnet.helius-rpc.com/?api-key=09e3cd33-67ef-42e3-8563-f42a3b863fd8';
const umi = createUmi(RPC_ENDPOINT);
/**
 * 🔒 100% 读取链上 Metaplex 数据，提取 Name 和 Symbol
 */
async function getAbsoluteTokenMetadata(mintAddress) {
    try {
        const mintPubKey = publicKey(mintAddress);
        const metadataPda = findMetadataPda(umi, { mint: mintPubKey });
        const metadata = await fetchMetadata(umi, metadataPda);

        // 清理链上 Byte 数据末尾填充的 \0 垃圾字符
        const name = metadata.name.replace(/\0/g, '').trim();
        const symbol = metadata.symbol.replace(/\0/g, '').trim();

        return {
            name: name || '未命名代币',
            symbol: symbol || 'UNKNOWN', // 👈 这里已经成功提取了 Symbol
        };
    } catch (err) {
        console.error(`⚠️ 链上读取代币 [${mintAddress}] 失败:`, err.message);
        return { name: '无 Metaplex 元数据代币', symbol: 'UNKNOWN' };
    }
}

// 导出模块供其他 js 文件调用
module.exports = {
    getAbsoluteTokenMetadata,
};


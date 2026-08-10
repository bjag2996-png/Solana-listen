const fs = require('fs');
const FILE_PATH = './processed_pools.json';

if (!fs.existsSync(FILE_PATH)) {
  fs.writeFileSync(FILE_PATH, JSON.stringify([]));
}

function isProcessed(poolId) {
  const records = JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8'));
  return records.includes(poolId);
}

function markProcessed(poolId) {
  const records = JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8'));
  if (!records.includes(poolId)) {
    records.push(poolId);
    fs.writeFileSync(FILE_PATH, JSON.stringify(records, null, 2));
  }
}

module.exports = { isProcessed, markProcessed };

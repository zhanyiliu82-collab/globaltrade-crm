// migrate-packings.js — 把现有产品的单箱规字段转为 packings 数组
// 用法：node migrate-packings.js [--apply]
// 不带 --apply 只预览，不改数据

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const APPLY = process.argv.includes('--apply');

const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const products = data.products || [];

let changed = 0;

products.forEach(p => {
  const already = Array.isArray(p.packings) && p.packings.length > 0;
  if (already) {
    console.log(`  跳过 ${p.sku}（已有 ${p.packings.length} 行箱规）`);
    return;
  }

  const row = {
    id: `PK-${p.id.replace('PROD-', '')}-1`,
    label: '主件',
    qtyPerCarton: Number(p.qtyPerCarton || 0),
    cartonL: Number(p.cartonL || 0),
    cartonW: Number(p.cartonW || 0),
    cartonH: Number(p.cartonH || 0),
    cbm: Number(p.cbm || 0),
    nwPerCarton: Number(p.nwPerCarton || 0),
    gwPerCarton: Number(p.gwPerCarton || 0),
    refPriceUSD: null
  };

  p.packings = [row];
  changed++;
  console.log(`  转换 ${p.sku}: ${row.qtyPerCarton} 只/箱, ${row.cartonL}×${row.cartonW}×${row.cartonH}cm, ${row.cbm}CBM`);
});

console.log('');
console.log(`共 ${products.length} 个产品，需要转换 ${changed} 个`);

if (!APPLY) {
  console.log('（预览模式，未写入。加 --apply 执行）');
  process.exit(0);
}

if (changed > 0) {
  // 原子写入
  const tmp = `${DATA_FILE}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  console.log(`已写入 ${DATA_FILE}`);
} else {
  console.log('无需改动');
}

// 汇率模块 — 从中国银行外汇牌价抓取，内存缓存 30 分钟
// 设计说明：
//   · 中行页面给的是「100 外币 = 多少人民币」，取「中行折算价」列（缺失时回退现汇卖出价）
//   · 服务器在境内，国外汇率 API 全部不可达，中行是唯一稳定免费的权威源
//   · 失败时返回上一次成功缓存，避免前端空白

const https = require("https");

const BOC_URL = "https://www.boc.cn/sourcedb/whpj/";
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 分钟
const FETCH_TIMEOUT_MS = 20000;

// 需要展示的主要货币（顺序即展示顺序）；名称与中行页面一致
const MAJOR = [
  "美元", "欧元", "英镑", "日元", "港币", "澳大利亚元", "加拿大元",
  "新加坡元", "瑞士法郎", "新西兰元", "韩国元", "泰国铢", "澳门元",
  "新台币", "卢布", "印度卢比", "越南盾", "菲律宾比索",
  "马来西亚林吉特", "林吉特", "印尼卢比", "土耳其里拉", "南非兰特",
  "沙特里亚尔", "阿联酋迪拉姆", "墨西哥比索", "瑞典克朗", "挪威克朗", "丹麦克朗",
];

// 中文名 -> ISO 代码（用于前端显示旗帜和工具对接）
const ISO_MAP = {
  "美元": "USD", "欧元": "EUR", "英镑": "GBP", "日元": "JPY", "港币": "HKD",
  "澳大利亚元": "AUD", "加拿大元": "CAD", "新加坡元": "SGD", "瑞士法郎": "CHF",
  "新西兰元": "NZD", "韩国元": "KRW", "泰国铢": "THB", "澳门元": "MOP",
  "新台币": "TWD", "卢布": "RUB", "印度卢比": "INR", "越南盾": "VND",
  "菲律宾比索": "PHP", "林吉特": "MYR", "印尼卢比": "IDR", "土耳其里拉": "TRY",
  "南非兰特": "ZAR", "沙特里亚尔": "SAR", "阿联酋迪拉姆": "AED",
  "墨西哥比索": "MXN", "瑞典克朗": "SEK", "挪威克朗": "NOK", "丹麦克朗": "DKK",
};

let cache = { at: 0, data: null, error: null };

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("重定向过多"));
    const req = https.get(
      url,
      {
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(httpGet(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error("HTTP " + res.statusCode));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    req.on("error", reject);
  });
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/** 解析中行牌价页：返回 { 更新时间, rates: [{ code, cnName, per100, unit, cny, buy, sell }] } */
function parseBoc(html) {
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const out = new Map();
  let publishTime = "";

  let m;
  while ((m = trRe.exec(html)) !== null) {
    const rowHtml = m[1];
    const cells = [];
    let c;
    tdRe.lastIndex = 0;
    while ((c = tdRe.exec(rowHtml)) !== null) cells.push(stripTags(c[1]));
    if (cells.length < 6) continue;

    const name = cells[0];
    if (!name || name.startsWith("【") || name === "货币名称") continue;

    const num = (s) => {
      const v = parseFloat(String(s).replace(/,/g, ""));
      return Number.isFinite(v) ? v : null;
    };

    // 列序：名称 | 现汇买入 | 现钞买入 | 现汇卖出 | 现钞卖出 | 中行折算价 | 发布时间
    const buy = num(cells[1]);
    const cashBuy = num(cells[2]);
    const sell = num(cells[3]);
    const mid = num(cells[5]);
    const price100 = mid ?? sell ?? buy ?? cashBuy;
    if (price100 === null || price100 <= 0) continue;

    if (!publishTime && cells[6]) publishTime = cells[6];

    // 特殊：日元、韩元等以 100 为单位；越南盾、印尼卢比等中行按 100 给但数值极小
    // 统一：中行所有货币都是「100 外币兑人民币」
    out.set(name, {
      cnName: name,
      code: ISO_MAP[name] || "",
      per100: price100,
      unit: 100,
      cny: price100 / 100,      // 1 外币 = ? CNY
      buy: buy !== null ? buy / 100 : null,
      sell: sell !== null ? sell / 100 : null,
    });
  }

  const list = [];
  const seen = new Set();
  for (const nm of MAJOR) {
    const hit = out.get(nm);
    if (hit && !seen.has(hit.code || nm)) {
      list.push(hit);
      seen.add(hit.code || nm);
    }
  }
  // 补上不在 MAJOR 列表里的其它货币（避免漏掉中行新加的）
  for (const [nm, v] of out) {
    if (!list.find((x) => x.cnName === nm)) list.push(v);
  }

  return { publishTime, rates: list };
}

async function fetchRates(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.data, cached: true, age: Math.floor((now - cache.at) / 1000) };
  }
  try {
    const html = await httpGet(BOC_URL);
    const parsed = parseBoc(html);
    if (!parsed.rates.length) throw new Error("未解析到汇率数据");
    cache = { at: Date.now(), data: parsed, error: null };
    return { ...parsed, cached: false, age: 0 };
  } catch (e) {
    cache.error = e.message;
    if (cache.data) {
      return { ...cache.data, cached: true, stale: true, age: Math.floor((now - cache.at) / 1000), error: e.message };
    }
    throw e;
  }
}

module.exports = { fetchRates, parseBoc, MAJOR, ISO_MAP };

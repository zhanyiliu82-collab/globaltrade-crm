const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// ==================== 全局防崩溃防击穿进程守护 ====================
process.on('uncaughtException', (err) => {
  console.error('[防崩守卫] 捕获未处理的全局异常，进程已自愈保护，继续服务:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[防崩守卫] 捕获未处理的 Promise 拒绝，已自愈保护:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'privkey.pem');
const CRT_FILE = path.join(CERT_DIR, 'fullchain.pem');

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(String(pwd)).digest('hex');
}

// 初始数据：包含管理员与业务员默认账户
const initialData = {
  users: [
    { username: 'admin', passwordHash: hashPassword('admin123'), name: '系统管理员 (Admin)', role: '管理员' },
    { username: 'sales', passwordHash: hashPassword('sales123'), name: '业务主管 (Sales)', role: '业务员' }
  ],
  customers: [],
  followUps: [],
  quotations: [],
  products: []
};

// 确保数据文件存在
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
    return initialData;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.products) parsed.products = [];
    if (!parsed.users || parsed.users.length === 0) parsed.users = initialData.users;
    return parsed;
  } catch (err) {
    console.error('[数据结构异常] 读取失败，使用内存初始结构保护:', err.message);
    return initialData;
  }
}

// 高并发原子文件写入（Atomic Write + Rename，防止写入中断导致文件损坏）
function saveData(data) {
  const tempFile = `${DATA_FILE}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFile, DATA_FILE);
  } catch (err) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
  }
}

// 会话 Token 缓存与手机验证码内存池
const activeTokens = new Map();
const smsCodes = new Map(); // phone -> { code, expireAt, lastSentAt }

// 提取当前请求携带的登录用户信息
function getReqUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/, '') || req.query.token;
  return token ? activeTokens.get(token) : null;
}

// ==================== 身份验证接口 ====================
// 1. 发送手机短信验证码
app.post('/api/auth/send-sms', (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1[3-9]\d{9}$/.test(phone.trim())) {
    return res.status(400).json({ error: '请输入有效的11位手机号码' });
  }

  const cleanPhone = phone.trim();
  const existing = smsCodes.get(cleanPhone);
  const now = Date.now();

  // 60秒防刷频限制
  if (existing && (now - existing.lastSentAt < 60000)) {
    const waitSec = Math.ceil((60000 - (now - existing.lastSentAt)) / 1000);
    return res.status(429).json({ error: `验证码发送过于频繁，请 ${waitSec} 秒后再试` });
  }

  // 生成6位随机数字验证码
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  smsCodes.set(cleanPhone, {
    code,
    expireAt: now + 5 * 60 * 1000, // 5分钟有效
    lastSentAt: now
  });

  console.log('=======================================================');
  console.log('[SMS 短信网关] 验证码已生成并投递:');
  console.log(`接收手机: ${cleanPhone}`);
  console.log(`验证代码: ${code} (5分钟有效)`);
  console.log(`短信模版: 【GlobalTrade CRM】您的登录验证码为：${code}，5分钟内有效，请勿泄露。`);
  console.log('=======================================================');

  res.json({
    success: true,
    message: '短信验证码发送成功',
    devCode: code,
    expireMinutes: 5
  });
});

// 2. 手机验证码登录
app.post('/api/auth/login-sms', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.status(400).json({ error: '请提供手机号和收到的短信验证码' });
  }

  const cleanPhone = phone.trim();
  const record = smsCodes.get(cleanPhone);
  const now = Date.now();

  if (!record || now > record.expireAt) {
    return res.status(400).json({ error: '验证码已失效或未获取，请重新获取' });
  }

  if (record.code !== code.trim()) {
    return res.status(400).json({ error: '验证码输入错误，请仔细核对' });
  }

  smsCodes.delete(cleanPhone);

  const data = loadData();
  let user = (data.users || []).find(u => u.phone === cleanPhone || u.username === `phone_${cleanPhone}`);

  if (!user) {
    user = {
      username: `user_${cleanPhone.slice(-4)}`,
      phone: cleanPhone,
      name: `外贸业务员 (${cleanPhone.slice(0,3)}****${cleanPhone.slice(-4)})`,
      role: '业务员',
      createdAt: new Date().toISOString().split('T')[0]
    };
    if (!data.users) data.users = [];
    data.users.push(user);
    saveData(data);
  }

  const token = `GT_PHONE_${crypto.randomBytes(24).toString('hex')}`;
  activeTokens.set(token, {
    username: user.username,
    name: user.name,
    role: user.role,
    phone: cleanPhone,
    loginAt: now
  });

  res.json({
    success: true,
    token,
    user: {
      username: user.username,
      name: user.name,
      role: user.role,
      phone: cleanPhone
    }
  });
});

// 3. 密码登录接口
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  const data = loadData();
  const inputHash = hashPassword(password);
  const user = (data.users || []).find(u =>
    u.username.toLowerCase() === username.trim().toLowerCase() &&
    (u.passwordHash === inputHash || u.password === password)
  );

  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误，请核对后再试' });
  }

  const token = `GT_${crypto.randomBytes(24).toString('hex')}`;
  activeTokens.set(token, {
    username: user.username,
    name: user.name,
    role: user.role,
    loginAt: Date.now()
  });

  res.json({
    success: true,
    token,
    user: {
      username: user.username,
      name: user.name,
      role: user.role
    }
  });
});

// 4. 自主注册新账号接口 (强绑定手机验证码)
app.post('/api/auth/register', (req, res) => {
  const { username, password, name, phone, smsCode, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '请填写登录账号和密码' });
  }
  if (!phone || !/^1[3-9]\d{9}$/.test(phone.trim())) {
    return res.status(400).json({ error: '请输入有效的11位手机号码进行安全绑定' });
  }
  if (!smsCode) {
    return res.status(400).json({ error: '请输入收到的手机短信验证码' });
  }

  const cleanPhone = phone.trim();
  const cleanUsername = username.trim().toLowerCase();

  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: '登录账号长度不能少于 3 位' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '登录密码长度不能少于 6 位' });
  }

  const record = smsCodes.get(cleanPhone);
  const now = Date.now();
  if (!record || now > record.expireAt) {
    return res.status(400).json({ error: '手机短信验证码已失效或未获取，请重新获取' });
  }
  if (record.code !== smsCode.trim()) {
    return res.status(400).json({ error: '手机短信验证码输入错误，请核对后再试' });
  }

  smsCodes.delete(cleanPhone);

  const data = loadData();
  if (!data.users) data.users = [];

  const existsUsername = data.users.find(u => u.username.toLowerCase() === cleanUsername);
  if (existsUsername) {
    return res.status(400).json({ error: '该登录账号已存在，请直接登录或换一个用户名' });
  }

  const existsPhone = data.users.find(u => u.phone === cleanPhone);
  if (existsPhone) {
    return res.status(400).json({ error: `该手机号已绑定账号 [${existsPhone.username}]，请直接登录` });
  }

  const newUser = {
    username: cleanUsername,
    passwordHash: hashPassword(password),
    name: (name && name.trim()) ? name.trim() : `外贸业务员 (${cleanUsername})`,
    phone: cleanPhone,
    role: role || '业务员',
    createdAt: new Date().toISOString().split('T')[0]
  };

  data.users.push(newUser);
  saveData(data);

  const token = `GT_${crypto.randomBytes(24).toString('hex')}`;
  activeTokens.set(token, {
    username: newUser.username,
    name: newUser.name,
    role: newUser.role,
    phone: cleanPhone,
    loginAt: Date.now()
  });

  res.json({
    success: true,
    token,
    user: {
      username: newUser.username,
      name: newUser.name,
      role: newUser.role,
      phone: cleanPhone
    }
  });
});

app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/, '') || req.query.token;
  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ error: '未登录或登录已失效' });
  }
  res.json({ success: true, user: activeTokens.get(token) });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/, '') || req.body.token;
  if (token) activeTokens.delete(token);
  res.json({ success: true });
});

app.post('/api/auth/change-password', (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  if (!username || !oldPassword || !newPassword) {
    return res.status(400).json({ error: '请提供完整的账号、原密码与新密码' });
  }

  const data = loadData();
  const oldHash = hashPassword(oldPassword);
  const user = (data.users || []).find(u =>
    u.username.toLowerCase() === username.trim().toLowerCase() &&
    (u.passwordHash === oldHash || u.password === oldPassword)
  );

  if (!user) {
    return res.status(401).json({ error: '原密码不正确' });
  }

  user.passwordHash = hashPassword(newPassword);
  delete user.password;
  saveData(data);
  res.json({ success: true, message: '密码修改成功' });
});

// ==================== 业务数据接口 ====================

// 【全局强制鉴权】所有业务接口必须携带有效 Token，否则一律拒绝
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/login') ||
      req.path.startsWith('/auth/login-sms') ||
      req.path.startsWith('/auth/send-sms') ||
      req.path.startsWith('/auth/register')) {
    return next();
  }
  const user = getReqUser(req);
  if (!user) {
    return res.status(401).json({ error: '未登录或登录已失效，请重新登录' });
  }
  req.authUser = user;
  next();
});

// 统计接口
app.get('/api/dashboard/stats', (req, res) => {
  const data = loadData();
  const reqUser = req.authUser;
  let custs = data.customers;
  let quotes = data.quotations;

  if (reqUser && reqUser.role !== '管理员') {
    const myName = reqUser.name;
    custs = custs.filter(c => c.status === 'public' || c.owner === myName);
    const myCustIds = new Set(custs.map(c => c.id));
    quotes = quotes.filter(q => myCustIds.has(q.customerId));
  }

  const total = custs.length;
  const privateCount = custs.filter(c => c.status === 'private').length;
  const publicCount = custs.filter(c => c.status === 'public').length;
  const wonCount = custs.filter(c => c.stage === '赢单成交').length;
  const totalQuoteAmount = quotes.reduce((acc, q) => acc + (Number(q.totalAmount) || 0), 0);

  const stages = ["潜在潜客", "初步接洽", "样品验证", "商机报价", "赢单成交"];
  const funnel = stages.map(st => ({
    stage: st,
    count: custs.filter(c => c.stage === st).length
  }));

  res.json({
    totalCustomers: total,
    privateCustomers: privateCount,
    publicCustomers: publicCount,
    dealsWon: wonCount,
    totalQuotationsUSD: Number(totalQuoteAmount.toFixed(2)),
    totalFollowups: data.followUps.length,
    funnel
  });
});

// 客户列表获取 (支持业务员权限隔离)
app.get('/api/customers', (req, res) => {
  const data = loadData();
  const { status, keyword, stage } = req.query;
  const reqUser = req.authUser || getReqUser(req);
  let list = data.customers;

  if (reqUser && reqUser.role !== '管理员') {
    const myName = reqUser.name;
    const myUsername = reqUser.username;
    list = list.filter(c => c.status === 'public' || c.owner === myName || c.owner === myUsername);
  }

  if (status) list = list.filter(c => c.status === status);
  if (stage) list = list.filter(c => c.stage === stage);
  if (keyword) {
    const kw = keyword.toLowerCase();
    list = list.filter(c =>
      c.companyName.toLowerCase().includes(kw) ||
      c.country.toLowerCase().includes(kw) ||
      c.contactName.toLowerCase().includes(kw) ||
      c.email.toLowerCase().includes(kw)
    );
  }

  res.json({ list });
});

// 新增客户 (自动绑定录入业务员)
app.post('/api/customers', (req, res) => {
  const data = loadData();
  const body = req.body;
  const reqUser = req.authUser || getReqUser(req);

  const exists = data.customers.find(c =>
    (c.email && c.email.toLowerCase() === (body.email || '').toLowerCase()) ||
    (c.companyName.toLowerCase() === (body.companyName || '').toLowerCase())
  );

  if (exists) {
    return res.status(400).json({ error: `撞单提醒：该企业或邮箱已存在！归属人：${exists.owner} (${exists.status === 'public' ? '公海' : '私海'})` });
  }

  const assignedOwner = (reqUser && reqUser.role !== '管理员')
    ? reqUser.name
    : (body.owner || (reqUser ? reqUser.name : '管理员'));

  const now = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const newCust = {
    id: `CUST-${Date.now().toString().slice(-6)}`,
    companyName: body.companyName || '未命名公司',
    country: body.country || 'Unknown',
    countryCode: body.countryCode || 'UN',
    website: body.website || '',
    scale: body.scale || '50人以下',
    contactName: body.contactName || '',
    email: body.email || '',
    phone: body.phone || '',
    stage: body.stage || '潜在潜客',
    status: body.status || 'private',
    owner: assignedOwner,
    source: body.source || '手工录入',
    rating: parseInt(body.rating, 10) || 3,
    mainProducts: body.mainProducts || '',
    createdAt: now,
    updatedAt: now
  };

  data.customers.unshift(newCust);
  saveData(data);
  res.json({ success: true, customer: newCust });
});

// 移入公海或捞取到私海
app.post('/api/customers/:id/transfer', (req, res) => {
  const data = loadData();
  const cust = data.customers.find(c => c.id === req.params.id);
  if (!cust) return res.status(404).json({ error: '客户不存在' });

  const reqUser = req.authUser || getReqUser(req);
  const { targetStatus, newOwner } = req.body;

  cust.status = targetStatus;
  if (targetStatus === 'public') {
    cust.owner = '公海公共池';
  } else {
    cust.owner = (reqUser && reqUser.name) ? reqUser.name : (newOwner || '业务员');
  }
  cust.updatedAt = new Date().toISOString().replace('T', ' ').substring(0, 16);

  saveData(data);
  res.json({ success: true, customer: cust });
});

// 删除客户
app.delete('/api/customers/:id', (req, res) => {
  const data = loadData();
  data.customers = data.customers.filter(c => c.id !== req.params.id);
  data.followUps = data.followUps.filter(f => f.customerId !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// 跟进记录列表
app.get('/api/followups', (req, res) => {
  const data = loadData();
  const { customerId } = req.query;
  let list = data.followUps;
  if (customerId) list = list.filter(f => f.customerId === customerId);
  res.json({ list });
});

// 新增跟进记录
app.post('/api/followups', (req, res) => {
  const data = loadData();
  const body = req.body;
  const reqUser = req.authUser || getReqUser(req);
  const now = new Date().toISOString().replace('T', ' ').substring(0, 16);

  const newFlw = {
    id: `FLW-${Date.now().toString().slice(-6)}`,
    customerId: body.customerId,
    type: body.type || 'Email',
    content: body.content || '',
    nextContactDate: body.nextContactDate || '',
    operator: (reqUser && reqUser.name) ? reqUser.name : (body.operator || '业务员'),
    createdAt: now
  };

  data.followUps.unshift(newFlw);

  const cust = data.customers.find(c => c.id === body.customerId);
  if (cust) {
    cust.updatedAt = now;
    if (body.newStage) cust.stage = body.newStage;
  }

  saveData(data);
  res.json({ success: true, followUp: newFlw });
});

// ==================== 产品库 (Product Catalog) 接口 ====================
app.get('/api/products', (req, res) => {
  const data = loadData();
  res.json({ list: data.products || [] });
});

app.post('/api/products', (req, res) => {
  const data = loadData();
  if (!data.products) data.products = [];
  const body = req.body;

  const l = Number(body.cartonL || 0);
  const w = Number(body.cartonW || 0);
  const h = Number(body.cartonH || 0);
  const cbm = (l > 0 && w > 0 && h > 0) ? Number(((l * w * h) / 1000000).toFixed(4)) : (Number(body.cbm) || 0.05);

  const newProd = {
    id: `PROD-${Date.now().toString().slice(-6)}`,
    sku: body.sku || `SKU-${Date.now().toString().slice(-4)}`,
    nameZh: body.nameZh || '未命名产品',
    nameEn: body.nameEn || 'Standard Export Product',
    hsCode: body.hsCode || '8424899990',
    taxRefundRate: body.taxRefundRate ? `${body.taxRefundRate}%` : '13%',
    unit: body.unit || 'pcs',
    refPriceUSD: Number(body.refPriceUSD || 0),
    qtyPerCarton: Number(body.qtyPerCarton || 500),
    cartonL: l,
    cartonW: w,
    cartonH: h,
    cbm: cbm,
    nwPerCarton: Number(body.nwPerCarton || 10),
    gwPerCarton: Number(body.gwPerCarton || 11.5),
    spec: body.spec || '',
    createdAt: new Date().toISOString().split('T')[0]
  };

  data.products.unshift(newProd);
  saveData(data);
  res.json({ success: true, product: newProd });
});

app.delete('/api/products/:id', (req, res) => {
  const data = loadData();
  data.products = (data.products || []).filter(p => p.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// ==================== 报价单 (PI) 与 装箱单 (Packing List) 接口 ====================
app.get('/api/quotations', (req, res) => {
  const data = loadData();
  res.json({ list: data.quotations });
});

app.post('/api/quotations', (req, res) => {
  const data = loadData();
  const body = req.body;
  const now = new Date().toISOString().split('T')[0];

  const total = (body.items || []).reduce((sum, item) => sum + (Number(item.quantity) * Number(item.unitPrice)), 0);

  let totalCartons = 0;
  let totalGw = 0;
  let totalNw = 0;
  let totalCbm = 0;

  (body.items || []).forEach(it => {
    const qty = Number(it.quantity || 0);
    const qpc = Number(it.qtyPerCarton || 100);
    const ctns = Math.ceil(qty / (qpc > 0 ? qpc : 100));
    totalCartons += ctns;
    totalGw += (ctns * Number(it.gwPerCarton || 12));
    totalNw += (ctns * Number(it.nwPerCarton || 10.5));
    totalCbm += (ctns * Number(it.cbm || 0.05));
  });

  const newPi = {
    id: `PI-${Date.now()}`,
    piNumber: `PI${now.replace(/-/g, '')}-${Math.floor(10 + Math.random() * 90)}`,
    customerId: body.customerId,
    customerName: body.customerName,
    contactName: body.contactName,
    currency: body.currency || 'USD',
    tradeTerm: body.tradeTerm || 'FOB Ningbo',
    paymentTerm: body.paymentTerm || '30% T/T Deposit, 70% before shipment',
    leadTime: body.leadTime || '25-30 days after sample approval',
    items: body.items || [],
    totalAmount: Number(total.toFixed(2)),
    totalCartons: totalCartons,
    totalGw: Number(totalGw.toFixed(2)),
    totalNw: Number(totalNw.toFixed(2)),
    totalCbm: Number(totalCbm.toFixed(3)),
    status: 'Draft',
    createdAt: now
  };

  data.quotations.unshift(newPi);
  saveData(data);
  res.json({ success: true, quotation: newPi });
});

// 删除报价单 (PI)
app.delete('/api/quotations/:id', (req, res) => {
  const data = loadData();
  data.quotations = data.quotations.filter(q => q.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// 健康检查
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// 前端路由兜底（Express 5 语法兼容）
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 全局统一容错防击穿中间件 ====================
app.use((err, req, res, next) => {
  console.error('[接口容错安全保护] 拦截到未处理异常:', err.message);
  res.status(500).json({ error: '系统保护性响应：请求发生异常，已自动保护并记录日志' });
});

// ==================== HTTP + HTTPS 双通道启动 ====================
function startHttpServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.on('error', (err) => {
      console.error(`[HTTP] 端口 ${PORT} 启动失败: ${err.code}`);
      resolve(null);
    });
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[HTTP ] 已监听 0.0.0.0:${PORT}`);
      resolve(server);
    });
  });
}

function startHttpsServer() {
  return new Promise((resolve) => {
    if (!fs.existsSync(KEY_FILE) || !fs.existsSync(CRT_FILE)) {
      console.log(`[HTTPS] 未找到证书（${CERT_DIR}），HTTPS 通道暂不启动`);
      console.log(`[HTTPS] 放入 privkey.pem 与 fullchain.pem 后执行 pm2 restart trade-crm 即可启用`);
      return resolve(null);
    }
    let creds;
    try {
      creds = {
        key: fs.readFileSync(KEY_FILE),
        cert: fs.readFileSync(CRT_FILE)
      };
      // 若存在中间证书链文件则一并加载
      const chainFile = path.join(CERT_DIR, 'chain.pem');
      if (fs.existsSync(chainFile)) {
        creds.ca = fs.readFileSync(chainFile);
      }
    } catch (e) {
      console.error('[HTTPS] 证书读取失败:', e.message);
      return resolve(null);
    }

    const server = https.createServer(creds, app);
    server.on('error', (err) => {
      console.error(`[HTTPS] 端口 ${HTTPS_PORT} 启动失败: ${err.code}`);
      resolve(null);
    });
    server.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[HTTPS] 已监听 0.0.0.0:${HTTPS_PORT}（安全加密通道已启用）`);
      resolve(server);
    });
  });
}

(async () => {
  console.log('=======================================================');
  console.log('[GlobalTrade CRM] 通用外贸智能管理平台启动中...');
  await startHttpServer();
  await startHttpsServer();
  console.log('高可用保护: 全局防崩守卫 + 原子写入 + 多员工数据隔离已生效');
  console.log('=======================================================');
})();

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const { isSameOriginRequest } = require("./lib/csrf");
const { decryptAccount, encryptAccount, parseAccountEntries } = require("./lib/delivery");
const { appendAccounts, findMatchingProduct } = require("./lib/inventory");
const FileSessionStore = require("./lib/session-store");
const { createSepayQrUrl, loadSepayConfig, parseSepayTransaction, processSepayTransaction, verifySepaySignature } = require("./lib/sepay");
const { createVnpayPaymentUrl, loadVnpayConfig, verifyVnpaySignature } = require("./lib/vnpay");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const DATA_DIR = process.env.GAMEHUB_DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const sessionSecretFile = path.join(DATA_DIR, ".session-secret");
const loadPersistentSessionSecret = () => {
  try {
    const storedSecret = fs.readFileSync(sessionSecretFile, "utf8").trim();
    if (storedSecret) return storedSecret;
    throw new Error("The stored session secret is empty.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const generatedSecret = crypto.randomBytes(48).toString("hex");
    try {
      fs.writeFileSync(sessionSecretFile, generatedSecret, { flag: "wx", mode: 0o600 });
      return generatedSecret;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      return fs.readFileSync(sessionSecretFile, "utf8").trim();
    }
  }
};
const configuredSessionSecret = process.env.SESSION_SECRET;
const sessionSecret = configuredSessionSecret || loadPersistentSessionSecret();
if (isProduction && (!configuredSessionSecret || configuredSessionSecret.length < 32)) {
  throw new Error("Production requires a SESSION_SECRET with at least 32 characters.");
}
const vnpayConfig = loadVnpayConfig();
const sepayConfig = loadSepayConfig();
const DB_FILE = path.join(DATA_DIR, "db.json");
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], products: [], orders: [], topups: [], gameCategories: [] }, null, 2));
}
const readDB = () => JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
const writeDB = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const aiRateLimits = new Map();
const AI_RATE_WINDOW_MS = 10 * 60 * 1000;
const AI_RATE_MAX_REQUESTS = 20;
const getStock = product => Array.isArray(product.accounts) ? product.accounts.length : 0;
const DEFAULT_GAME_CATEGORIES=["Liên Quân","Free Fire","Roblox"];
const normalizeGameName=name=>String(name||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const getGameCategories=gameNames=>{
  const uniqueNames=[...new Set(gameNames.filter(Boolean))];
  const categories=DEFAULT_GAME_CATEGORIES.map(label=>({
    name:uniqueNames.find(name=>normalizeGameName(name)===normalizeGameName(label))||label,
    label
  }));
  uniqueNames.forEach(name=>{
    if(!categories.some(category=>normalizeGameName(category.name)===normalizeGameName(name))){
      categories.push({name,label:name});
    }
  });
  return categories;
};
const savedGameCategories=db=>Array.isArray(db.gameCategories)
  ?db.gameCategories.filter(category=>typeof category==="string"&&category.trim())
  :[];
const rememberGameCategory=(db,name)=>{
  const gameName=String(name||"").trim();
  if(!gameName) return;
  if(!Array.isArray(db.gameCategories)) db.gameCategories=[];
  if(!db.gameCategories.some(category=>normalizeGameName(category)===normalizeGameName(gameName))){
    db.gameCategories.push(gameName);
  }
};
const allowAiRequest = ip => {
  const now=Date.now();
  for(const [key,value] of aiRateLimits){
    if(value.resetAt<=now) aiRateLimits.delete(key);
  }
  const current=aiRateLimits.get(ip);
  if(current&&current.count>=AI_RATE_MAX_REQUESTS) return false;
  if(current) current.count++;
  else aiRateLimits.set(ip,{count:1,resetAt:now+AI_RATE_WINDOW_MS});
  return true;
};
const getLeaderboard = (db, limit = 10) => {
  const totals = new Map();
  db.topups.filter(t => t.status === "paid").forEach(t => {
    const amount=Number(t.amount);
    if(Number.isFinite(amount)&&amount>0) totals.set(t.userId, (totals.get(t.userId) || 0) + amount);
  });
  return db.users
    .filter(user => user.role !== "admin")
    .map(user => {
      const firstCharacter=Array.from(String(user.name||"").trim())[0];
      return {
        name: firstCharacter ? `${firstCharacter}***` : "Thành viên",
        total: totals.get(user.id) || 0
      };
    })
    .filter(user => user.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map((user, index) => ({ ...user, rank: index + 1 }));
};

async function seed() {
  const db = readDB();
  let changed = false;
  if (!db.users.some(u => u.role === "admin")) {
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
      throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD before creating the first admin.");
    }
    db.users.push({
      id: 1, name: "Quản trị viên", email: process.env.ADMIN_EMAIL.trim().toLowerCase(),
      password: await bcrypt.hash(process.env.ADMIN_PASSWORD, 10),
      role: "admin", balance: 0, createdAt: new Date().toISOString()
    });
    changed = true;
  }
  if (changed) writeDB(db);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
if (isProduction) app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  limit: "10kb",
  verify:(req,res,buffer)=>{
    if(req.path==="/api/sepay/webhook") req.rawBody=Buffer.from(buffer);
  }
}));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  store: new FileSessionStore({
    directory: path.join(DATA_DIR, "sessions"),
    ttlMs: SESSION_TTL_MS,
    secret: sessionSecret
  }),
  secret: sessionSecret,
  resave: false, saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: SESSION_TTL_MS }
}));
app.use((req,res,next)=>{
  res.set("Cache-Control","no-store");
  next();
});

app.use((req,res,next)=>{
  if(!req.session.csrfToken) req.session.csrfToken=crypto.randomBytes(32).toString("hex");
  const db=readDB();
  const sessionUser=req.session.user ? db.users.find(u=>u.id===req.session.user.id) : null;
  res.locals.user=sessionUser ? {
    id:sessionUser.id,
    name:sessionUser.name,
    email:sessionUser.email,
    role:sessionUser.role,
    balance:sessionUser.balance
  } : null;
  res.locals.csrfToken=req.session.csrfToken;
  res.locals.money=n=>Number(n||0).toLocaleString("vi-VN")+"₫";
  res.locals.notice=req.session.notice; delete req.session.notice;
  next();
});
app.use((req,res,next)=>{
  if(req.method!=="POST"||req.path==="/api/ai/chat"||req.path==="/api/sepay/webhook") return next();
  const expected=Buffer.from(String(req.session.csrfToken||""));
  const supplied=Buffer.from(String(req.body?._csrf||""));
  if(expected.length!==supplied.length||!crypto.timingSafeEqual(expected,supplied)){
    if(req.path==="/dang-nhap"){
      const source=req.get("origin")||req.get("referer");
      if(isSameOriginRequest(source,req.get("host"))) return next();
    }
    return res.status(403).render("message",{title:"Phiên đăng nhập đã hết hạn",message:"Biểu mẫu cũ không còn hợp lệ. Hãy tải lại trang đăng nhập rồi gửi lại biểu mẫu."});
  }
  next();
});
const notice=(req,msg)=>req.session.notice=msg;
const auth=(req,res,next)=>{
  if(!req.session.user){
    notice(req,"Vui lòng đăng nhập để tiếp tục.");
    return res.redirect("/dang-nhap");
  }
  if(readDB().users.some(user=>user.id===req.session.user.id)) return next();
  delete req.session.user;
  notice(req,"Tài khoản không còn tồn tại. Vui lòng đăng nhập lại.");
  return res.redirect("/dang-nhap");
};
const adminAuth=(req,res,next)=>req.session.user ? next() : (notice(req,"Vui lòng đăng nhập bằng tài khoản quản trị để tiếp tục."),res.redirect("/dang-nhap"));
const admin=(req,res,next)=> {
  const db=readDB(), u=db.users.find(x=>x.id===req.session.user?.id);
  if(u?.role==="admin") return next();
  notice(req,"Bạn không có quyền truy cập khu vực quản trị."); res.redirect("/");
};
const establishAuthenticatedSession=(req,res,user,message,destination)=>{
  req.session.regenerate(error=>{
    if(error){
      console.error("Could not regenerate session after authentication.",error);
      return res.status(500).render("message",{
        title:"Không thể đăng nhập",
        message:"Không thể tạo phiên đăng nhập an toàn. Vui lòng thử lại."
      });
    }
    req.session.csrfToken=crypto.randomBytes(32).toString("hex");
    req.session.user={id:user.id};
    notice(req,message);
    res.redirect(destination);
  });
};

const renderCatalog=(req,res,routeGame="")=>{
  const db=readDB();
  const q=typeof req.query.q==="string"?req.query.q.trim().slice(0,100):"";
  const requestedGame=routeGame||(typeof req.query.game==="string"?req.query.game:"");
  const allProducts=db.products.map(p=>({...p,stock:getStock(p)}));
  const categoryNames=[...savedGameCategories(db),...allProducts.map(product=>product.game)];
  const knownCategories=getGameCategories(categoryNames);
  const game=knownCategories.find(category=>normalizeGameName(category.name)===normalizeGameName(requestedGame))?.name||requestedGame;
  if(routeGame&&!knownCategories.some(category=>normalizeGameName(category.name)===normalizeGameName(routeGame))){
    return res.status(404).render("message",{title:"Không tìm thấy danh mục",message:"Danh mục game này hiện không có sản phẩm trong kho."});
  }
  const categories=getGameCategories(categoryNames).map(category=>({
    ...category,
    stock:allProducts.filter(product=>normalizeGameName(product.game)===normalizeGameName(category.name)).reduce((total,product)=>total+product.stock,0),
    selected:normalizeGameName(game)===normalizeGameName(category.name),
    image:category.label==="Roblox"
      ?"/images/roblox-category.jpg"
      :category.label==="Free Fire"
        ?"/images/free-fire-category.jpg"
        :normalizeGameName(category.name).includes("lien quan")
          ?"/images/lien-quan-airi.jpg"
          :"",
    href:`/game/${encodeURIComponent(category.name)}${q?`?q=${encodeURIComponent(q)}`:""}`
  }));
  const gameImage=categories.find(category=>category.selected)?.image||"";
  let products=allProducts.filter(p=>p.stock>0);
  if(q) products=products.filter(p=>(p.name+" "+p.game+" "+p.description).toLowerCase().includes(q.toLowerCase()));
  if(game) products=products.filter(p=>normalizeGameName(p.game)===normalizeGameName(game));
  res.render("index",{
    products,categories,q,game,gameImage,
    catalogTotalStock:allProducts.reduce((total,product)=>total+product.stock,0),
    catalogTitle:game?`${game} - Tài khoản game`:"Cửa hàng tài khoản game",
    catalogAction:game?`/game/${encodeURIComponent(game)}`:"/",
    allCategoryHref:q?`/?q=${encodeURIComponent(q)}`:"/",
    topUsers:getLeaderboard(db,3),
    paymentReady:Boolean(vnpayConfig),
    bankReady:Boolean(sepayConfig)
  });
};
app.get("/",(req,res)=>renderCatalog(req,res));
app.get("/game/:game",(req,res)=>renderCatalog(req,res,req.params.game));
app.get("/san-pham/:id",(req,res)=>{
  const db=readDB(), product=db.products.find(p=>p.id===Number(req.params.id));
  if(!product||getStock(product)===0) return res.status(404).render("message",{title:"Không tìm thấy",message:"Sản phẩm hiện không có tài khoản trong kho."});
  res.render("product",{product:{...product,stock:getStock(product)}});
});
app.get("/dang-ky",(req,res)=>res.render("auth",{mode:"register"}));
app.post("/dang-ky",async(req,res)=>{
  const {name,email,password}=req.body, db=readDB();
  if(!name?.trim()||!email?.trim()||!password||password.length<8){notice(req,"Vui lòng nhập đủ thông tin. Mật khẩu tối thiểu 8 ký tự.");return res.redirect("/dang-ky");}
  if(db.users.some(u=>u.email.toLowerCase()===email.trim().toLowerCase())){notice(req,"Email đã được sử dụng.");return res.redirect("/dang-ky");}
  const user={id:Date.now(),name:name.trim(),email:email.trim().toLowerCase(),password:await bcrypt.hash(password,10),role:"user",balance:0,createdAt:new Date().toISOString()};
  db.users.push(user);writeDB(db);
  establishAuthenticatedSession(req,res,user,"Đăng ký thành công! Phiên đăng nhập trên thiết bị này sẽ được ghi nhớ tối đa 30 ngày.","/tai-khoan");
});
app.get("/dang-nhap",(req,res)=>res.render("auth",{mode:"login"}));
app.post("/dang-nhap",async(req,res)=>{
  const db=readDB(), email=String(req.body.email||"").trim().toLowerCase();
  const user=db.users.find(u=>String(u.email||"").trim().toLowerCase()===email);
  if(!user||!(await bcrypt.compare(req.body.password||"",user.password))){notice(req,"Email hoặc mật khẩu chưa chính xác.");return res.redirect("/dang-nhap");}
  establishAuthenticatedSession(req,res,user,"Đăng nhập thành công. Thiết bị này sẽ được ghi nhớ tối đa 30 ngày.",user.role==="admin"?"/admin":"/tai-khoan");
});
app.post("/dang-xuat",(req,res)=>req.session.destroy(error=>{
  if(error){
    console.error("Could not destroy session during logout.",error);
    return res.status(500).render("message",{
      title:"Không thể đăng xuất",
      message:"Không thể kết thúc phiên đăng nhập. Vui lòng thử lại."
    });
  }
  res.clearCookie("connect.sid",{httpOnly:true,sameSite:"lax",secure:isProduction,path:"/"});
  res.redirect("/");
}));
app.get("/tai-khoan",auth,(req,res)=>{
  res.set("Cache-Control","no-store");
  const db=readDB(), user=db.users.find(u=>u.id===req.session.user.id);
  const orders=db.orders.filter(o=>o.userId===user.id&&o.delivery).reverse().map(order=>({
    ...order,
    delivery:order.delivery?decryptAccount(order.delivery):null
  }));
  res.render("account",{orders,topups:db.topups.filter(t=>t.userId===user.id).reverse()});
});
app.post("/mua/:id",auth,(req,res)=>{
  const db=readDB(), user=db.users.find(u=>u.id===req.session.user.id), p=db.products.find(x=>x.id===Number(req.params.id)&&getStock(x)>0);
  if(!p){notice(req,"Sản phẩm hiện không khả dụng.");return res.redirect("/");}
  if(user.balance<p.price){notice(req,"Số dư chưa đủ. Hãy tạo yêu cầu nạp tiền.");return res.redirect("/nap-tien");}
  const delivery=p.accounts.shift();
  user.balance-=p.price;
  p.status=getStock(p)>0?"available":"sold";
  db.orders.push({
    id:Date.now(),userId:user.id,productId:p.id,productName:p.name,price:p.price,
    status:"completed",delivery,createdAt:new Date().toISOString()
  });
  writeDB(db);notice(req,"Mua hàng thành công. Thông tin tài khoản đã được giao trong tài khoản của bạn.");res.redirect("/tai-khoan");
});
app.get("/nap-tien",auth,(req,res)=>res.render("topup",{
  paymentReady:Boolean(vnpayConfig),
  bankReady:Boolean(sepayConfig)
}));
app.post("/nap-tien",auth,(req,res)=>{
  if(!vnpayConfig){
    notice(req,"Thanh toán VNPay chưa sẵn sàng. Cần cấu hình tài khoản merchant và URL HTTPS công khai.");
    return res.redirect("/nap-tien");
  }
  const amount=Number(req.body.amount), methodKey=String(req.body.method||"");
  if(!Number.isInteger(amount)||amount<10000||amount>50000000){notice(req,"Số tiền phải từ 10.000₫ đến 50.000.000₫.");return res.redirect("/nap-tien");}
  const db=readDB();
  let txnRef;
  do {
    txnRef=crypto.randomBytes(16).toString("hex");
  } while(db.topups.some(t=>String(t.id)===txnRef));
  const topup={id:txnRef,userId:req.session.user.id,amount,method:"VNPay",status:"pending",createdAt:new Date().toISOString()};
  const paymentUrl=createVnpayPaymentUrl(vnpayConfig,{
    amount,txnRef,ipAddr:req.ip
  });
  db.topups.push(topup);
  writeDB(db);
  res.redirect(paymentUrl);
});
app.post("/nap-tien/chuyen-khoan",auth,(req,res)=>{
  if(!sepayConfig){
    notice(req,"Chuyển khoản ngân hàng chưa được cấu hình.");
    return res.redirect("/nap-tien");
  }
  const amount=Number(req.body.amount);
  if(!Number.isInteger(amount)||amount<10000||amount>50000000){
    notice(req,"Số tiền phải từ 10.000₫ đến 50.000.000₫.");
    return res.redirect("/nap-tien");
  }
  const db=readDB();
  let id,reference;
  do {
    id=crypto.randomBytes(16).toString("hex");
    reference=`GTN${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  } while(db.topups.some(t=>String(t.id)===id||t.bankReference===reference));
  db.topups.push({
    id,userId:req.session.user.id,amount,method:"SePay",status:"pending",
    bankReference:reference,createdAt:new Date().toISOString()
  });
  writeDB(db);
  res.redirect(`/nap-tien/chuyen-khoan/${id}`);
});
app.get("/nap-tien/chuyen-khoan/:id",auth,(req,res)=>{
  if(!sepayConfig) return res.status(503).render("message",{
    title:"Chuyển khoản ngân hàng",
    message:"Phương thức chuyển khoản chưa được cấu hình."
  });
  const topup=readDB().topups.find(t=>
    String(t.id)===req.params.id&&t.userId===req.session.user.id&&t.method==="SePay"
  );
  if(!topup) return res.status(404).render("message",{
    title:"Không tìm thấy giao dịch",
    message:"Không tìm thấy yêu cầu nạp tiền này."
  });
  res.render("bank-transfer",{
    topup,
    bank:{
      code:sepayConfig.bankCode,
      accountNumber:sepayConfig.accountNumber,
      accountName:sepayConfig.accountName
    },
    qrUrl:createSepayQrUrl(sepayConfig,{amount:topup.amount,reference:topup.bankReference})
  });
});

app.get("/nap-tien/ket-qua",(req,res)=>{
  if(!vnpayConfig||!verifyVnpaySignature(req.query,vnpayConfig.hashSecret)){
    return res.status(400).render("message",{title:"Kết quả thanh toán",message:"Không xác minh được kết quả thanh toán. Số dư chưa được cộng."});
  }
  if(!req.query.vnp_TxnRef||!/^\d+$/.test(req.query.vnp_Amount||"")){
    return res.status(400).render("message",{title:"Kết quả thanh toán",message:"Thông tin giao dịch không hợp lệ. Số dư chưa được cộng."});
  }
  const db=readDB();
  const topup=db.topups.find(t=>String(t.id)===req.query.vnp_TxnRef);
  if(!topup||Number(req.query.vnp_Amount)!==topup.amount*100||req.query.vnp_TmnCode!==vnpayConfig.tmnCode){
    return res.status(400).render("message",{title:"Kết quả thanh toán",message:"Thông tin giao dịch không khớp. Số dư chưa được cộng."});
  }
  if(topup.status==="paid"){
    notice(req,"Thanh toán thành công. Số dư đã được cập nhật.");
    return res.redirect("/tai-khoan");
  }
  const succeeded=req.query.vnp_ResponseCode==="00"&&req.query.vnp_TransactionStatus==="00";
  const message=succeeded
    ?"VNPay đã chuyển kết quả về. Hệ thống đang xác nhận giao dịch; số dư sẽ được cộng sau khi nhận thông báo IPN."
    :"Giao dịch chưa thành công. Số dư chưa được cộng.";
  res.render("message",{title:"Kết quả thanh toán",message});
});

app.get("/api/vnpay/ipn",(req,res)=>{
  const respond=(RspCode,Message)=>res.json({RspCode,Message});
  if(!vnpayConfig||!verifyVnpaySignature(req.query,vnpayConfig.hashSecret)){
    return respond("97","Invalid signature");
  }
  const requiredFields=["vnp_TmnCode","vnp_TxnRef","vnp_Amount","vnp_ResponseCode","vnp_TransactionStatus","vnp_TransactionNo"];
  if(requiredFields.some(field=>!req.query[field])||!/^\d+$/.test(req.query.vnp_Amount)){
    return respond("99","Missing transaction data");
  }
  const db=readDB();
  const topup=db.topups.find(t=>String(t.id)===req.query.vnp_TxnRef);
  if(!topup)return respond("01","Order not found");
  if(req.query.vnp_TmnCode!==vnpayConfig.tmnCode)return respond("97","Invalid merchant");
  if(Number(req.query.vnp_Amount)!==topup.amount*100)return respond("04","Invalid amount");
  if(topup.status!=="pending")return respond("02","Order already confirmed");
  const user=db.users.find(entry=>entry.id===topup.userId);
  if(!user)return respond("01","Customer not found");

  const succeeded=req.query.vnp_ResponseCode==="00"&&req.query.vnp_TransactionStatus==="00";
  topup.status=succeeded?"paid":"failed";
  topup.transactionNo=String(req.query.vnp_TransactionNo||"");
  topup.bankCode=String(req.query.vnp_BankCode||"");
  topup.paidAt=succeeded?new Date().toISOString():null;
  if(succeeded)user.balance+=topup.amount;
  writeDB(db);
  return respond("00","Confirm Success");
});
app.post("/api/sepay/webhook",(req,res)=>{
  if(!sepayConfig) return res.status(503).json({success:false,message:"SePay is not configured."});
  if (!verifySepaySignature({
  authorization: req.get("authorization"),
  signature: req.get("x-sepay-signature"),
  timestamp: req.get("x-sepay-timestamp"),
  rawBody: req.rawBody,
  secret: sepayConfig.webhookSecret
})) {
    return res.status(401).json({success:false,message:"Unauthorized."});
  }
  const transaction=parseSepayTransaction(req.body);
  if(!transaction) return res.status(400).json({success:false,message:"Invalid transaction payload."});
  const db=readDB();
  const result=processSepayTransaction(db,sepayConfig,transaction);
  if(result.processed) writeDB(db);
  if(!result.success) console.warn(`SePay event was not credited: ${result.reason}.`);
  return res.status(200).json({
    success:result.success,
    ...(result.duplicate?{duplicate:true}:{})
  });
});

app.get("/bang-xep-hang",(req,res)=>{
  res.render("leaderboard",{leaders:getLeaderboard(readDB())});
});

app.post("/api/ai/chat",async(req,res)=>{
  const apiKey=process.env.OPENAI_API_KEY?.trim();
  if(!apiKey){
    return res.status(503).json({error:"Trợ lý AI chưa được cấu hình. Hãy thêm OPENAI_API_KEY vào tệp .env."});
  }
  if(typeof fetch!=="function"){
    console.error("AI chat requires a Node.js runtime with global fetch support.");
    return res.status(503).json({error:"Máy chủ chưa hỗ trợ kết nối AI. Hãy cập nhật Node.js LTS."});
  }
  if(!allowAiRequest(req.ip||"unknown")){
    return res.status(429).json({error:"Bạn đã gửi quá nhiều câu hỏi. Vui lòng thử lại sau ít phút."});
  }
  const submittedMessages=req.body?.messages;
  if(!Array.isArray(submittedMessages)||submittedMessages.length<1||submittedMessages.length>8){
    return res.status(400).json({error:"Lịch sử hội thoại không hợp lệ."});
  }
  const messages=[];
  let totalLength=0;
  for(const message of submittedMessages){
    if(!message||!["user","assistant"].includes(message.role)||typeof message.content!=="string"){
      return res.status(400).json({error:"Tin nhắn không hợp lệ."});
    }
    const content=message.content.trim();
    if(!content||content.length>1500){
      return res.status(400).json({error:"Mỗi tin nhắn cần có nội dung và không quá 1.500 ký tự."});
    }
    totalLength+=content.length;
    messages.push({role:message.role,content});
  }
  if(totalLength>6000||messages[messages.length-1].role!=="user"){
    return res.status(400).json({error:"Hội thoại quá dài hoặc chưa có câu hỏi mới."});
  }

  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),20000);
  try{
    const apiResponse=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",
      headers:{
        "Authorization":`Bearer ${apiKey}`,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        model:process.env.OPENAI_MODEL||"gpt-4.1-mini",
        instructions:"Bạn là trợ lý thân thiện của GTN Gaming Store. Trả lời câu hỏi tổng quát bằng tiếng Việt khi phù hợp. Không khẳng định trạng thái thanh toán, số dư, tồn kho hoặc giao dịch nếu không có dữ liệu xác minh; hướng dẫn khách kiểm tra tài khoản hoặc liên hệ hỗ trợ. Không yêu cầu người dùng gửi mật khẩu, mã xác thực, thông tin ngân hàng hoặc khóa API. Nếu không chắc chắn, hãy nói rõ giới hạn thay vì bịa đặt.",
        input:messages,
        max_output_tokens:500,
        store:false
      }),
      signal:controller.signal
    });
    if(!apiResponse.ok){
      console.error(`OpenAI chat request failed with status ${apiResponse.status}.`);
      return res.status(502).json({error:"Dịch vụ AI chưa thể trả lời. Vui lòng thử lại sau."});
    }
    const result=await apiResponse.json();
    const reply=(result.output||[])
      .flatMap(item=>item.content||[])
      .filter(item=>item.type==="output_text"||item.type==="refusal")
      .map(item=>item.text||item.refusal||"")
      .filter(Boolean)
      .join("\n")
      .trim();
    if(!reply){
      console.error("OpenAI chat response contained no text output.");
      return res.status(502).json({error:"AI không trả về nội dung. Vui lòng thử lại."});
    }
    return res.json({reply:reply.slice(0,5000)});
  }catch(error){
    console.error("OpenAI chat request failed.",error);
    return res.status(502).json({error:"Không kết nối được với dịch vụ AI. Vui lòng thử lại sau."});
  }finally{
    clearTimeout(timeout);
  }
});

app.get("/admin",adminAuth,admin,(req,res)=>{
  const db=readDB();
  const customers=db.users.filter(user=>user.role!=="admin");
  const categories=getGameCategories([...savedGameCategories(db),...db.products.map(product=>product.game)]).map(category=>({
    ...category,
    stock:db.products.filter(product=>normalizeGameName(product.game)===normalizeGameName(category.name)).reduce((total,product)=>total+getStock(product),0),
    href:`/admin?game=${encodeURIComponent(category.name)}`
  }));
  const requestedGame=typeof req.query.game==="string"?req.query.game:"";
  const selectedGame=categories.find(category=>normalizeGameName(category.name)===normalizeGameName(requestedGame))?.name||"";
  res.render("admin",{
    products:db.products.filter(product=>!selectedGame||normalizeGameName(product.game)===normalizeGameName(selectedGame)).map(p=>({...p,stock:getStock(p)})),
    categories,selectedGame,
    users:customers.map(user=>({
      id:user.id,name:user.name,email:user.email,role:user.role,balance:user.balance
    })),
    orders:db.orders.filter(order=>order.delivery).slice().reverse(),
    topups:db.topups.slice().reverse(),
    stats:{
      products:db.products.length,
      inventory:db.products.reduce((total,p)=>total+getStock(p),0),
      users:customers.length,
      orders:db.orders.filter(order=>order.delivery).length,
      revenue:db.orders.filter(order=>order.delivery).reduce((sum,order)=>sum+order.price,0)
    }
  });
});
app.post("/admin/san-pham",adminAuth,admin,(req,res)=>{
  const game=String(req.body.game||"").trim(),name=String(req.body.name||"").trim();
  const description=String(req.body.description||"").trim(),image=String(req.body.image||"").trim();
  const price=Number(req.body.price),db=readDB();
  let accounts;
  try{
    accounts=parseAccountEntries(req.body.accounts).map(account=>encryptAccount(account));
  }catch(error){
    notice(req,error.message);
    return res.redirect("/admin");
  }
  if(!game||game.length>60||!name||name.length>120||description.length>1000||image.length>500||
    !Number.isInteger(price)||price<1000||price>50000000){
    notice(req,"Vui lòng nhập danh mục, tên, giá và thông tin sản phẩm hợp lệ.");
    return res.redirect("/admin");
  }
  const existingProduct=findMatchingProduct(db.products,game,name);
  if(existingProduct){
    if(!accounts.length){
      notice(req,"Sản phẩm cùng tên và danh mục đã có. Hãy nhập tài khoản để bổ sung kho, hoặc chỉnh sửa sản phẩm hiện có.");
      return res.redirect(`/admin?game=${encodeURIComponent(existingProduct.game)}`);
    }
    rememberGameCategory(db,game);
    const previousStock=getStock(existingProduct);
    const totalStock=appendAccounts(existingProduct,accounts);
    writeDB(db);
    notice(req,`Đã thêm ${accounts.length} tài khoản vào sản phẩm hiện có; giữ nguyên ${previousStock} tài khoản cũ (${totalStock} tài khoản trong kho). Thông tin sản phẩm cũ không thay đổi.`);
    return res.redirect(`/admin?game=${encodeURIComponent(existingProduct.game)}`);
  }
  rememberGameCategory(db,game);
  db.products.push({
    id:Date.now(),game,name,description,image,price,accounts,
    status:accounts.length>0?"available":"sold",createdAt:new Date().toISOString()
  });
  writeDB(db);notice(req,"Đã thêm sản phẩm.");res.redirect(`/admin?game=${encodeURIComponent(game)}`);
});
app.post("/admin/san-pham/:id/cap-nhat",adminAuth,admin,(req,res)=>{
  const db=readDB(),product=db.products.find(p=>p.id===Number(req.params.id));
  if(!product){notice(req,"Không tìm thấy sản phẩm.");return res.redirect("/admin");}
  const game=String(req.body.game||"").trim(),name=String(req.body.name||"").trim();
  const description=String(req.body.description||"").trim(),image=String(req.body.image||"").trim();
  const price=Number(req.body.price);
  let accounts;
  try{
    accounts=parseAccountEntries(req.body.accounts).map(account=>encryptAccount(account));
  }catch(error){
    notice(req,error.message);
    return res.redirect("/admin");
  }
  if(!game||game.length>60||!name||name.length>120||description.length>1000||image.length>500||
    !Number.isInteger(price)||price<1000||price>50000000){
    notice(req,"Thông tin sản phẩm không hợp lệ.");
    return res.redirect("/admin");
  }
  rememberGameCategory(db,product.game);
  rememberGameCategory(db,game);
  appendAccounts(product,accounts);
  Object.assign(product,{game,name,description,image,price});
  writeDB(db);notice(req,"Đã cập nhật sản phẩm và mã hàng đã được mã hóa.");res.redirect(`/admin?game=${encodeURIComponent(game)}`);
});
app.post("/admin/san-pham/:id/xoa",adminAuth,admin,(req,res)=>{
  const db=readDB(),product=db.products.find(p=>p.id===Number(req.params.id));
  if(product) rememberGameCategory(db,product.game);
  db.products=db.products.filter(p=>p.id!==Number(req.params.id));writeDB(db);notice(req,"Đã xóa sản phẩm.");
  res.redirect(product?`/admin?game=${encodeURIComponent(product.game)}`:"/admin");
});
app.post("/admin/thanh-vien/:id/xoa",adminAuth,admin,(req,res)=>{
  const db=readDB(),userIndex=db.users.findIndex(user=>String(user.id)===req.params.id);
  if(userIndex<0){notice(req,"Không tìm thấy thành viên.");return res.redirect("/admin");}
  if(db.users[userIndex].role==="admin"){notice(req,"Không thể xóa tài khoản quản trị.");return res.redirect("/admin");}
  db.users.splice(userIndex,1);
  writeDB(db);
  notice(req,"Đã xóa tài khoản thành viên. Lịch sử đơn hàng và giao dịch nạp tiền được giữ lại.");
  res.redirect("/admin");
});
app.use((req,res)=>res.status(404).render("message",{title:"404",message:"Trang bạn tìm không tồn tại."}));
const PORT = process.env.PORT || 3000;
seed().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`GTN GAMING SHOP dang chay tai port ${PORT}`));
}).catch((error) => {
  console.error("GTN GAMING SHOP failed to start.", error);
  process.exitCode = 1;
}).catch(error=>{
  console.error("GTN GAMING SHOP failed to start.",error);
  process.exitCode=1;
});

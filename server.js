const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const DATA_ROOT = path.resolve(process.env.KSTUDIO_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'K Studio'));
fs.mkdirSync(DATA_ROOT,{recursive:true});
function migrateLegacyData(){
  if(DATA_ROOT===ROOT)return;
  for(const name of ['settings.json','accounts.json','history.json']){
    const oldFile=path.join(ROOT,name),newFile=path.join(DATA_ROOT,name);
    if(!fs.existsSync(newFile)&&fs.existsSync(oldFile))fs.copyFileSync(oldFile,newFile);
  }
  for(const name of ['.muse-chrome-profile','.muse-profiles','.uploads']){
    const oldDir=path.join(ROOT,name),newDir=path.join(DATA_ROOT,name);
    if(!fs.existsSync(newDir)&&fs.existsSync(oldDir)){
      const staging=newDir+'.migrating';
      fs.cpSync(oldDir,staging,{recursive:true});
      fs.renameSync(staging,newDir);
    }
  }
}
migrateLegacyData();
const PORT = Number(process.env.PORT || 4173);
const batches = new Map();
const MUSE_PROFILE = path.join(DATA_ROOT, '.muse-chrome-profile');
const CHROME_CANDIDATES = [process.env.KSTUDIO_CHROME_PATH,path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe'),process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe')].filter(Boolean);
const CHROME_PATH = CHROME_CANDIDATES.find(candidate=>fs.existsSync(candidate));
const HISTORY_FILE = path.join(DATA_ROOT, 'history.json');
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
const ACCOUNTS_FILE = path.join(DATA_ROOT, 'accounts.json');
const REFERENCE_DIR = path.join(DATA_ROOT, '.uploads', 'references');
const DEFAULT_SETTINGS = { outputDir: path.join(DATA_ROOT, 'output'), imageWorkers: 2, videoWorkers: 2, imageTimeout: 6, videoTimeout: 12, promptSeparator: '', allowedDomainsEnabled: true, allowedDomains: 'huggingface.co', autoReservePercent: 5 };
const outputReservations = new Set();
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
let accounts = [{ id:'default', name:'Tài khoản Muse', enabled:true, primary:true, profileDir:MUSE_PROFILE, createdAt:new Date().toISOString() }];
try { const saved=JSON.parse(fs.readFileSync(ACCOUNTS_FILE,'utf8')); if(Array.isArray(saved)&&saved.length) accounts=saved; } catch {}
for(const account of accounts)account.profileDir=account.id==='default'?MUSE_PROFILE:path.join(DATA_ROOT,'.muse-profiles',account.id);
let museContext = null;
let musePage = null;
let museAccountId = 'default';
let museConnectPromise = null;
let museState = 'disconnected';
let museQueue = Promise.resolve();
let resumeTimer = null;
const QUOTA_RECHECK_MS = 6 * 60 * 60 * 1000;
const scheduledBatches = new Set();
const runningBatches = new Set();
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
try { for (const batch of JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))){
  for(const job of batch.jobs||[]){
    if(job.referenceImagePath){const relative=path.relative(path.join(ROOT,'.uploads'),job.referenceImagePath);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)){const migrated=path.join(DATA_ROOT,'.uploads',relative);if(fs.existsSync(migrated))job.referenceImagePath=migrated;}}
  }
  batches.set(batch.id,batch);
} } catch {}
function persistHistory() {
  const all=Array.from(batches.values()),finished=new Set(all.filter(b=>['Hoàn tất','Hoàn tất, có lỗi','Lỗi'].includes(b.status)).slice(-100).map(b=>b.id));
  fs.writeFileSync(HISTORY_FILE,JSON.stringify(all.filter(b=>!['Hoàn tất','Hoàn tất, có lỗi','Lỗi'].includes(b.status)||finished.has(b.id)),null,2),'utf8');
}
function persistSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8'); }
function persistAccounts() { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8'); }
function quotaMessage(text) {
  const value=String(text||'').toLowerCase();
  const patterns=[
    /(?:weekly|daily|monthly)\s+(?:usage\s+)?(?:limit|quota)\s+(?:(?:is|has\s+been)\s+)?(?:reached|exceeded|used\s+up)/,
    /(?:reached|exceeded|used\s+up)\s+(?:your\s+)?(?:weekly|daily|monthly)\s+(?:usage\s+)?(?:limit|quota)/,
    /(?:out\s+of|not\s+enough|insufficient|no\s+more)\s+(?:available\s+)?(?:credits?|tokens?)/,
    /(?:credits?|tokens?)\s+(?:have\s+)?(?:run\s+out|exhausted|depleted)/,
    /(?:video|image|generation)\s+(?:usage\s+)?(?:limit|quota)\s+(?:has\s+been\s+)?(?:reached|exceeded)/,
    /(?:no\s+more|out\s+of)\s+(?:video|image|generation)s?\s+(?:left|remaining|available)/,
    /(?:hết|không\s+đủ|đã\s+dùng\s+hết)\s+(?:token|tín\s+dụng|hạn\s+mức)/i,
    /(?:hạn\s+mức)\s+(?:tuần|ngày|tháng)?\s*(?:đã\s+)?(?:hết|đạt|vượt)/i,
  ];
  for(const re of patterns){const match=value.match(re);if(match)return match[0]}
  return null;
}
function isQuotaError(error){return error?.code==='MUSE_QUOTA';}
function checkQuotaReply(text,oldText,prompt){
  const newer=String(text||'').replace(String(prompt||''),'');
  const reason=quotaMessage(newer);
  if(reason){const error=new Error('Muse báo hết token hoặc hạn mức.');error.code='MUSE_QUOTA';error.reason=reason;throw error;}
}
function accountAvailable(account){const blocked=Date.parse(account.quotaBlockedAt||'');return account.enabled && (!Number.isFinite(blocked)||Date.now()-blocked>=QUOTA_RECHECK_MS);}
function scheduleResume(){
  if(resumeTimer)clearTimeout(resumeTimer);
  const pending=Array.from(batches.values()).some(b=>b.status.startsWith('Tạm dừng')&&b.jobs.some(j=>j.status==='Trong hàng đợi'));
  if(!pending)return;
  const times=accounts.filter(a=>a.enabled&&a.quotaBlockedAt).map(a=>Date.parse(a.quotaBlockedAt)+QUOTA_RECHECK_MS).filter(t=>Number.isFinite(t)&&t>Date.now());
  if(times.length)resumeTimer=setTimeout(()=>{resumeTimer=null;resumePausedBatches()},Math.min(...times)-Date.now()+1000);
}
function queueBatch(batch){
  if(scheduledBatches.has(batch.id)||runningBatches.has(batch.id))return;
  scheduledBatches.add(batch.id);
  museQueue=museQueue.then(async()=>{scheduledBatches.delete(batch.id);runningBatches.add(batch.id);try{await runMuseBatch(batch)}finally{runningBatches.delete(batch.id);scheduleResume()}}).catch(e=>{batch.status='Lỗi kết nối Muse';batch.error=e.message;persistHistory()});
}
function resumePausedBatches(){for(const batch of batches.values())if(batch.status.startsWith('Tạm dừng')&&batch.jobs.some(j=>j.status==='Trong hàng đợi'))queueBatch(batch);scheduleResume()}
function museContextIsAlive() {
  if (!museContext) return false;
  try {
    const browser = museContext.browser?.();
    if (browser && !browser.isConnected()) return false;
    museContext.pages();
    return true;
  } catch { return false; }
}
async function discardStaleMuseContext() {
  const stale = museContext;
  museContext = null;
  musePage = null;
  museState = 'disconnected';
  if (stale) await stale.close().catch(() => {});
}

function respond(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, {'content-type': type, 'cache-control':'no-store'});
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function outputRootDir(){const configured=path.resolve(settings.outputDir||DEFAULT_SETTINGS.outputDir);return path.basename(configured).toLowerCase()==='images'?path.dirname(configured):configured}
function resolveOutputFile(value){const root=outputRootDir(),relative=String(value||'').trim();if(!relative)return null;const target=path.resolve(root,relative),fromRoot=path.relative(root,target);if(fromRoot==='..'||fromRoot.startsWith(`..${path.sep}`)||path.isAbsolute(fromRoot))return null;return target}
function openInExplorer(target,selectFile=false){return new Promise((resolve,reject)=>{const argument=selectFile?`/select,${target}`:target,child=spawn('explorer.exe',[argument],{detached:true,stdio:'ignore',windowsHide:false});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve()})})}
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks=[];let bytes=0,tooLarge=false;req.on('data',chunk=>{bytes+=chunk.length;if(bytes>90_000_000){tooLarge=true;reject(new Error('Dữ liệu tải lên quá lớn (giới hạn tổng 90 MB).'));req.destroy();return}chunks.push(chunk)});
    req.on('end',()=>{if(tooLarge)return;try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'))}catch{reject(new Error('JSON không hợp lệ'))}});
  });
}
function detect(prompt) {
  if (/^\s*video\s*:/i.test(prompt)) return 'Video';
  if (/^\s*(ảnh|anh)\s*:/i.test(prompt)) return 'Ảnh';
  if (/\b(video|clip|motion|chuyển động)\b/i.test(prompt)) return 'Video';
  if (/\b(ảnh|hình|photo|image)\b/i.test(prompt)) return 'Ảnh';
  return 'Cần xem lại';
}
function publicBatch(batch) {
  const root=outputRootDir();
  return {id:batch.id,status:batch.status,workers:batch.workers,accountId:batch.accountId||'default',activeAccountId:batch.activeAccountId||null,createdAt:batch.createdAt,jobs:batch.jobs.map(j=>{let outputSize=null,outputRelativePath=null;try{if(j.outputPath){outputRelativePath=path.relative(root,path.resolve(j.outputPath));if(fs.existsSync(j.outputPath))outputSize=fs.statSync(j.outputPath).size}}catch{}const outputUrl=outputRelativePath?'/api/output/'+outputRelativePath.split(path.sep).map(encodeURIComponent).join('/'):null;return{id:j.id,prompt:j.prompt,type:j.type,status:j.status,error:j.error||null,accountId:j.accountId||null,outputPath:j.outputPath||null,outputRelativePath,outputUrl,outputSize,hasReferenceImage:Boolean(j.referenceImagePath),referenceName:j.referenceName||null,startedAt:j.startedAt||null,finishedAt:j.finishedAt||null}})};
}
async function runBatch(batch) {
  batch.status = 'Cần kết nối Muse';
  for (const job of batch.jobs) job.status = 'Cần kết nối Muse';
  persistHistory();
}
async function connectMuse(accountId='default', hidden=false) {
  if (museConnectPromise) return museConnectPromise;
  museConnectPromise = (async () => {
    const account=accounts.find(a=>a.id===accountId);
    if(!account||!account.enabled) throw new Error('Tài khoản không tồn tại hoặc đã tắt.');
    if (museContext && !museContextIsAlive()) await discardStaleMuseContext();
    if(museContext && museContext.pages().length && museAccountId!==accountId) await discardStaleMuseContext();
    if (!museContext || museContext.pages().length === 0) {
      if(!CHROME_PATH)throw new Error('Không tìm thấy Google Chrome trên máy. Hãy cài Chrome hoặc đặt KSTUDIO_CHROME_PATH.');
      const profile=accountId==='default'?MUSE_PROFILE:path.join(DATA_ROOT,'.muse-profiles',accountId);
      fs.mkdirSync(profile,{recursive:true}); account.profileDir=profile;
      museContext = await chromium.launchPersistentContext(profile, {
        executablePath: CHROME_PATH,
        headless: false,
        // Keep the Muse login window compact so it can sit beside K Studio.
        viewport: { width: 780, height: 530 },
        args: ['--window-size=800,600'],
        acceptDownloads: true,
      });
      const launchedContext = museContext;
      launchedContext.on('close', () => {
        if (museContext === launchedContext) {
          museContext = null;
          musePage = null;
          museState = 'disconnected';
        }
      });
    }
    museAccountId=accountId;
    musePage = museContext.pages()[0] || await museContext.newPage();
    await setMuseWindowState('normal');
    if(!/^https?:\/\/(www\.)?muse\.ai\//i.test(musePage.url())) await musePage.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' });
    await musePage.waitForTimeout(1500);
    museState = await isMuseReady(musePage) ? 'ready' : 'login_required';
    await setMuseWindowState(hidden && museState==='ready' ? 'minimized' : 'normal');
    return museStatus();
  })();
  try { return await museConnectPromise; }
  finally { museConnectPromise = null; }
}
async function setMuseWindowState(windowState) {
  if(!museContext) return false;
  let browserSession;
  try {
    browserSession=await museContext.browser().newBrowserCDPSession();
    const {windowId}=await browserSession.send('Browser.getWindowForTarget');
    await browserSession.send('Browser.setWindowBounds',{windowId,bounds:{windowState}});
    return true;
  } catch { return false; }
  finally { if(browserSession) await browserSession.detach().catch(()=>{}); }
}
async function isMuseReady(page) {
  try { await page.getByRole('textbox', { name: /Message/i }).first().waitFor({state:'visible',timeout:15000}); return true; }
  catch { return false; }
}
async function startNewMuseConversation(page) {
  const sideChats=page.getByText(/^Side chats$/i).first();
  if(!await sideChats.isVisible().catch(()=>false)){
    const toggles=[
      page.getByRole('button',{name:/^(chats?|conversations?)$/i}),
      page.locator('button[aria-label*="chat" i],button[title*="chat" i],a[aria-label*="chat" i],[role="button"][aria-label*="chat" i],button[aria-label*="conversation" i],[role="button"][aria-label*="conversation" i]')
    ];
    let opened=false;
    for(const locator of toggles){
      const count=await locator.count().catch(()=>0);
      for(let i=0;i<count;i++){
        const candidate=locator.nth(i);
        if(await candidate.isVisible().catch(()=>false)){
          await candidate.click({timeout:5000});
          await sideChats.waitFor({state:'visible',timeout:5000}).catch(()=>{});
          if(await sideChats.isVisible().catch(()=>false)){opened=true;break}
        }
      }
      if(opened)break;
    }
  }
  if(!await sideChats.isVisible().catch(()=>false)) throw new Error('Không mở được danh sách Side chats trên Muse; đã dừng để tránh gửi prompt vào hội thoại cũ.');
  const previousUrl=page.url();
  // Muse renders the Side chats heading and its + control in separate DOM branches
  // in some layouts. Locate the visible control by its position in the same row.
  const clicked=await sideChats.evaluate((heading)=>{
    const visible=(el)=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
    const hr=heading.getBoundingClientRect();
    let ancestor=heading;
    for(let depth=0;depth<7&&ancestor;depth++,ancestor=ancestor.parentElement){
      const controls=[...ancestor.querySelectorAll('button,[role="button"],a,[tabindex]:not([tabindex="-1"])')].filter(visible);
      const candidates=controls.map(el=>{const r=el.getBoundingClientRect(),label=[el.getAttribute('aria-label'),el.getAttribute('title'),el.innerText,el.textContent].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();return {el,label,r,dy:Math.abs((r.top+r.bottom)/2-(hr.top+hr.bottom)/2),dx:r.left-hr.right}})
        .filter(x=>x.dy<=Math.max(24,hr.height)&&x.dx>=-4&&x.dx<180);
      const explicit=candidates.filter(x=>/new.*side\s*chat|side\s*chat|add.*chat|create.*chat/i.test(x.label)||/^\s*[+＋]\s*$/.test(x.label));
      const choices=explicit.length?explicit:candidates;
      choices.sort((a,b)=>a.dx-b.dx);
      if(choices.length){choices[0].el.click();return {ok:true,label:choices[0].label||'(icon)',depth,dx:Math.round(choices[0].dx),dy:Math.round(choices[0].dy)}}
    }
    return {ok:false};
  }).catch(()=>({ok:false}));
  if(!clicked.ok) throw new Error('Không tìm thấy nút + cạnh Side chats trên Muse; đã dừng để tránh gửi prompt vào hội thoại cũ.');
  try { await page.waitForURL(url=>url.href!==previousUrl,{timeout:10000}); }
  catch { throw new Error(`Đã bấm nút cạnh Side chats nhưng Muse không chuyển sang chat mới (URL vẫn ${previousUrl}); đã dừng để tránh gửi prompt vào hội thoại cũ.`); }
  await page.getByRole('textbox',{name:/Message/i}).first().waitFor({state:'visible',timeout:15000});
  await page.waitForTimeout(500);
}
function museStatus() {
  return { state: museState, url: musePage?.url() || null, title: musePage ? 'Muse' : null, accountId:museAccountId };
}
function safeFilename(prompt) {
  return prompt.replace(/^\s*(ảnh|anh|video)\s*:\s*/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 90) || 'Muse result';
}
function imageOutputDir() {
  return path.join(outputRootDir(),'images');
}
function videoOutputDir() { return path.join(outputRootDir(),'videos'); }
function outputDirFor(type) {
  const target=type==='Ảnh'?imageOutputDir():videoOutputDir();
  fs.mkdirSync(target, { recursive: true });
  return target;
}
function reserveOutputPath(prompt,ext,type){const dir=outputDirFor(type);let file=safeFilename(prompt)+ext,index=2,target=path.join(dir,file);while(fs.existsSync(target)||outputReservations.has(target)){file=`${safeFilename(prompt)} (${index++})${ext}`;target=path.join(dir,file)}outputReservations.add(target);return target}
async function waitForMuseReply(page, oldText, prompt, timeoutMs = 180000) {
  const started = Date.now();
  let sawBusy = false;
  while (Date.now() - started < timeoutMs) {
    const text = await page.locator('body').innerText().catch(() => '');
    checkQuotaReply(text,oldText,prompt);
    const stopCount = await page.getByRole('button', { name: /Stop/i }).count().catch(() => 0);
    if (stopCount > 0) sawBusy = true;
    const generatedCount = await page.getByRole('button', { name: /Open generated image/i }).count().catch(() => 0);
    const changed = text.length > oldText.length && !text.endsWith('Assistant is typing');
    if (sawBusy && stopCount === 0 && (changed || generatedCount > 0)) return { text, generatedCount };
    await page.waitForTimeout(1200);
  }
  throw new Error('Muse chưa hoàn tất trong thời gian chờ.');
}
async function waitForMuseVideoResult(page, previousCount, previousGeneratedCount, oldText, prompt, timeoutMs) {
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    const videoCount=await page.locator('video').count().catch(()=>0);
    // Muse labels generated clips as "Open animated video" in the chat UI.
    // Accept both labels because the accessible name differs across layouts.
    const generatedCount=await page.getByRole('button',{name:/Open (?:generated|animated) video/i}).count().catch(()=>0);
    if(videoCount>previousCount||generatedCount>previousGeneratedCount)return;
    checkQuotaReply(await page.locator('body').innerText().catch(()=>''),oldText,prompt);
    await page.waitForTimeout(1200);
  }
  throw new Error('Muse đã trả lời nhưng video chưa hiện để tải trong thời gian chờ tối đa.');
}
async function downloadLatestImage(page, previousCount, previousDownloadCount, prompt) {
  const images = page.getByRole('button', { name: /Open generated image/i });
  const count = await images.count();
  const directDownloads = page.getByRole('button', { name: 'Download', exact: true });
  if (count > previousCount) await images.last().click();
  else if (await directDownloads.count() <= previousDownloadCount) return null;
  const downloadButton = page.getByRole('button', { name: 'Download', exact: true });
  await downloadButton.waitFor({ state: 'visible', timeout: 10000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await downloadButton.click();
  const download = await downloadPromise;
  const ext = path.extname(download.suggestedFilename()) || '.png';
  const target=reserveOutputPath(prompt,ext,'Ảnh');
  try{await download.saveAs(target)}finally{outputReservations.delete(target)}
  const close = page.getByRole('button', { name: 'Close' });
  if (await close.count()) await close.last().click().catch(() => {});
  return target;
}
async function downloadLatestVideo(page, previousCount, previousGeneratedCount, prompt, timeoutMs = 15000) {
  const videos = page.locator('video');
  const count = await videos.count();
  const generated = page.getByRole('button', { name: /Open (?:generated|animated) video/i });
  const generatedCount = await generated.count();
  if (count <= previousCount && generatedCount <= previousGeneratedCount) return null;
  if (generatedCount > 0) await generated.last().click();
  const downloadButton = page.getByRole('button', { name: /Download/i }).last();
  await downloadButton.waitFor({ state: 'visible', timeout: Math.max(1000,timeoutMs) });
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await downloadButton.click();
  const download = await downloadPromise;
  const ext = path.extname(download.suggestedFilename()) || '.mp4';
  const target=reserveOutputPath(prompt,ext,'Video');
  try{await download.saveAs(target)}finally{outputReservations.delete(target)}
  const close = page.getByRole('button', { name: 'Close' });
  if (await close.count()) await close.last().click().catch(() => {});
  return target;
}
async function runMuseBatch(batch) {
  batch.status = 'Đang chạy trên Muse';
  try {
    const start=Math.max(0,accounts.findIndex(a=>a.id===batch.accountId));
    const ordered=[...accounts.slice(start),...accounts.slice(0,start)].filter(a=>a.enabled);
    let quotaAccounts=0;
    for(const account of ordered){
    if(!batch.jobs.some(j=>j.status==='Trong hàng đợi'))break;
    if(!accountAvailable(account)){quotaAccounts++;continue}
    let status;
    try{status=museContextIsAlive()&&musePage&&!musePage.isClosed()&&museState==='ready'&&museAccountId===account.id?museStatus():await connectMuse(account.id,true)}
    catch(e){continue}
    if(status.state!=='ready')continue;
    batch.activeAccountId=account.id;
    await setMuseWindowState('minimized');
    for (const job of batch.jobs) if(job.type==='Cần xem lại'){job.status='Cần xem lại';job.error='Thêm tiền tố Ảnh: hoặc Video: để xác định loại tác vụ.'}
    const queues={ 'Ảnh':batch.jobs.filter(j=>j.type==='Ảnh'&&j.status==='Trong hàng đợi'), 'Video':batch.jobs.filter(j=>j.type==='Video'&&j.status==='Trong hàng đợi') };
    const cursors={ 'Ảnh':0, 'Video':0 };
    let quotaHit=false;
    async function worker(type,index){
      const queue=queues[type];
      while(!quotaHit&&cursors[type]<queue.length){const job=queue[cursors[type]++];if(!batch.jobs.includes(job))continue;let page=null;
        try{
          if(!museContextIsAlive()){
            await discardStaleMuseContext();
            const recovered=await connectMuse(account.id,true);
            if(recovered.state!=='ready')throw new Error('Phiên Muse đã đóng; cần đăng nhập lại trong cửa sổ Muse rồi chạy lại tác vụ.');
          }
          try { page=await museContext.newPage(); }
          catch (e) {
            if(!/Target page, context or browser has been closed/i.test(e.message))throw e;
            await discardStaleMuseContext();
            const recovered=await connectMuse(account.id,true);
            if(recovered.state!=='ready')throw new Error('Phiên Muse đã đóng; cần đăng nhập lại trong cửa sổ Muse rồi chạy lại tác vụ.');
            page=await museContext.newPage();
          }
          await page.goto('https://muse.ai/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(1200);
          if(!await isMuseReady(page))throw new Error('Phiên Muse cần đăng nhập lại.');
          await startNewMuseConversation(page);
          if(job.referenceImagePath){
            const attach=page.locator('button[aria-label="Attach file"]').first();
            if(!await attach.count())throw new Error('Không tìm thấy nút đính kèm ảnh trên Muse.');
            const chooserPromise=page.waitForEvent('filechooser',{timeout:10000});
            await attach.click();
            const chooser=await chooserPromise;
            await chooser.setFiles(job.referenceImagePath);
            await page.getByRole('button',{name:'Remove attachment',exact:true}).first().waitFor({state:'visible',timeout:15000});
            await page.waitForTimeout(700);
          }
          const textbox=page.getByRole('textbox',{name:/Message/i}).first(),oldText=await page.locator('body').innerText(),oldImages=await page.getByRole('button',{name:/Open generated image/i}).count(),oldImageDownloads=await page.getByRole('button',{name:'Download',exact:true}).count(),oldVideos=await page.locator('video').count(),oldGeneratedVideos=await page.getByRole('button',{name:/Open generated video/i}).count();
          checkQuotaReply(oldText,'',job.prompt);
          const timeoutMs=(type==='Ảnh'?settings.imageTimeout:settings.videoTimeout)*60_000,deadline=Date.now()+timeoutMs;
          job.status='Đang gửi lên Muse';job.accountId=account.id;job.startedAt=new Date().toISOString();job.worker=index+1;persistHistory();await textbox.fill(job.prompt);
          try{await page.getByRole('button',{name:'Send',exact:true}).click()}
          catch(e){checkQuotaReply(await page.locator('body').innerText().catch(()=>''),oldText,job.prompt);throw e}
          job.status='Đang tạo trên Muse';persistHistory();
          if(type==='Ảnh'){
            await waitForMuseReply(page,oldText,job.prompt,Math.max(1000,deadline-Date.now()));
            job.outputPath=await downloadLatestImage(page,oldImages,oldImageDownloads,job.prompt);
          }else{
            // Look for the actual new clip instead of relying on a transient
            // "Stop" button that may disappear before the first poll.
            await waitForMuseVideoResult(page,oldVideos,oldGeneratedVideos,oldText,job.prompt,Math.max(1000,deadline-Date.now()));
            job.outputPath=await downloadLatestVideo(page,oldVideos,oldGeneratedVideos,job.prompt,Math.max(1000,deadline-Date.now()));
          }
          if(!job.outputPath)throw new Error('Muse hoàn tất nhưng không tìm thấy file để tải.');job.status='Hoàn tất';job.error=null;job.finishedAt=new Date().toISOString();
        }catch(e){if(isQuotaError(e)){quotaHit=true;account.quotaBlockedAt=new Date().toISOString();account.quotaReason=e.reason;persistAccounts();job.status='Trong hàng đợi';job.error=null;job.startedAt=null;job.accountId=null;}else{job.status='Lỗi';job.error=e.message;}}
        finally{if(page&&page!==musePage)await page.close().catch(()=>{});persistHistory()}
      }
    }
    const work=[];for(const type of ['Ảnh','Video']){const count=batch.jobs.filter(j=>j.type===type).length,limit=Math.min(count,Math.max(1,Math.min(4,Number(settings[type==='Ảnh'?'imageWorkers':'videoWorkers'])||1)));for(let i=0;i<limit;i++)work.push(worker(type,i))}batch.workers=work.length;await Promise.all(work);
    if(quotaHit)quotaAccounts++;
    }
    if(batch.jobs.some(j=>j.status==='Trong hàng đợi'))batch.status=quotaAccounts?'Tạm dừng: hết hạn mức':'Tạm dừng: cần đăng nhập';
    else batch.status=batch.jobs.some(j=>j.status==='Lỗi')?'Hoàn tất, có lỗi':'Hoàn tất';
    persistHistory();
  } catch (e) {
    museState = 'error'; batch.status = 'Tạm dừng: cần đăng nhập';batch.error=e.message;
    persistHistory();
  }
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET' && url.pathname==='/api/health') return respond(res,200,{ok:true,mode:'local',museConnected:museState==='ready'});
  if(req.method==='GET' && url.pathname==='/api/version') return respond(res,200,{version:'kstudio-account-rotation-v18',appVersion:require('./package.json').version});
  if(req.method==='GET' && url.pathname==='/api/settings') return respond(res,200,settings);
  if(req.method==='GET' && url.pathname==='/api/accounts') return respond(res,200,{activeId:museAccountId,state:museState,accounts:accounts.map(a=>({id:a.id,name:a.name,enabled:a.enabled,primary:a.primary,open:!!(museContext&&museAccountId===a.id),session:museAccountId===a.id?museState:'Chưa mở',quotaBlocked:!accountAvailable(a)&&a.enabled,quotaBlockedAt:a.quotaBlockedAt||null,quotaReason:a.quotaReason||null,quotaRetryAt:a.quotaBlockedAt?new Date(Date.parse(a.quotaBlockedAt)+QUOTA_RECHECK_MS).toISOString():null,jobs:Array.from(batches.values()).reduce((n,b)=>n+b.jobs.filter(j=>(j.accountId||b.accountId)===a.id).length,0)}))});
  if(req.method==='POST' && url.pathname==='/api/accounts') {
    try { const data=await bodyJson(req),name=String(data.name||'').trim();if(!name)return respond(res,400,{error:'Nhập tên tài khoản.'});const account={id:crypto.randomUUID().replace(/-/g,''),name,enabled:true,primary:false,profileDir:path.join(ROOT,'.muse-profiles'),createdAt:new Date().toISOString()};accounts.push(account);persistAccounts();return respond(res,201,{id:account.id,name:account.name,enabled:account.enabled,primary:account.primary,open:false,session:'Chưa đăng nhập'}); } catch(e){return respond(res,400,{error:e.message});}
  }
  if(req.method==='POST' && url.pathname.startsWith('/api/accounts/') && url.pathname.endsWith('/open')) {
    const id=url.pathname.split('/')[3];if(runningBatches.size&&id!==museAccountId)return respond(res,409,{error:'Tài khoản hiện tại còn tác vụ đang chạy. Đợi xong rồi chuyển phiên.'});try{const result=await connectMuse(id);if(result.state==='ready')resumePausedBatches();return respond(res,200,result);}catch(e){museState='error';return respond(res,500,{state:museState,error:e.message});}
  }
  if(req.method==='POST' && url.pathname.startsWith('/api/accounts/') && url.pathname.endsWith('/retry-quota')) {
    const id=url.pathname.split('/')[3],account=accounts.find(a=>a.id===id);if(!account)return respond(res,404,{error:'Không tìm thấy tài khoản.'});
    delete account.quotaBlockedAt;delete account.quotaReason;persistAccounts();resumePausedBatches();return respond(res,200,{ok:true});
  }
  if(req.method==='PUT' && url.pathname.startsWith('/api/accounts/')) {
    const id=url.pathname.split('/')[3],account=accounts.find(a=>a.id===id);if(!account)return respond(res,404,{error:'Không tìm thấy tài khoản.'});
      try{const data=await bodyJson(req);if(data.name!==undefined){const name=String(data.name).trim();if(!name)return respond(res,400,{error:'Tên tài khoản không được để trống.'});account.name=name}if(data.enabled!==undefined){if(!data.enabled&&runningBatches.size&&museAccountId===id)return respond(res,409,{error:'Tài khoản còn tác vụ đang chạy.'});account.enabled=Boolean(data.enabled);if(!account.enabled&&accounts.filter(a=>a.enabled).length===0)return respond(res,400,{error:'Cần giữ ít nhất một tài khoản đang bật.'});if(!account.enabled&&account.primary){account.primary=false;const next=accounts.find(a=>a.enabled);if(next)next.primary=true}if(!account.enabled&&museAccountId===id&&museContext){await museContext.close().catch(()=>{});museContext=null;musePage=null;museState='disconnected'}}if(data.primary){if(!account.enabled)return respond(res,400,{error:'Hãy bật tài khoản trước.'});for(const a of accounts)a.primary=false;account.primary=true}if(data.move){const from=accounts.indexOf(account),to=Math.max(0,Math.min(accounts.length-1,from+Number(data.move)));accounts.splice(from,1);accounts.splice(to,0,account)}persistAccounts();if(data.enabled)resumePausedBatches();return respond(res,200,{id:account.id,name:account.name,enabled:account.enabled,primary:account.primary,open:museAccountId===id&&!!museContext,session:museAccountId===id?museState:'Chưa mở'});}catch(e){return respond(res,400,{error:e.message});}
  }
  if(req.method==='DELETE' && url.pathname.startsWith('/api/accounts/')) {
    const id=url.pathname.split('/')[3];if(Array.from(batches.values()).some(b=>b.accountId===id&&!['Hoàn tất','Hoàn tất, có lỗi','Lỗi kết nối Muse','Chờ đăng nhập Muse','Lỗi'].includes(b.status)))return respond(res,409,{error:'Tài khoản còn tác vụ đang chạy.'});if(accounts.length<=1)return respond(res,400,{error:'Phải giữ lại ít nhất một tài khoản.'});const index=accounts.findIndex(a=>a.id===id);if(index<0)return respond(res,404,{error:'Không tìm thấy tài khoản.'});if(museAccountId===id&&museContext){await museContext.close().catch(()=>{});museContext=null;musePage=null;museState='disconnected';}accounts.splice(index,1);if(!accounts.some(a=>a.primary))accounts[0].primary=true;persistAccounts();return respond(res,200,{ok:true});
  }
  if(req.method==='PUT' && url.pathname==='/api/settings') {
    try {
      const data=await bodyJson(req);
      if(data.outputDir!==undefined) { const p=path.resolve(String(data.outputDir)); if(!path.isAbsolute(p)) return respond(res,400,{error:'Thư mục lưu không hợp lệ.'}); settings.outputDir=p; }
      for(const key of ['imageWorkers','videoWorkers']) if(data[key]!==undefined) settings[key]=Math.max(1,Math.min(4,Number(data[key])||2));
      for(const key of ['imageTimeout','videoTimeout']) if(data[key]!==undefined) settings[key]=Math.max(1,Math.min(240,Number(data[key])||DEFAULT_SETTINGS[key]));
      for(const key of ['allowedDomainsEnabled','allowedDomains','promptSeparator','autoReservePercent']) if(data[key]!==undefined) settings[key]=key==='autoReservePercent'?Math.max(0,Math.min(100,Number(data[key])||0)):data[key];
      persistSettings(); return respond(res,200,settings);
    } catch(e) { return respond(res,400,{error:e.message}); }
  }
  if(req.method==='GET' && url.pathname==='/api/library') {
    const dir=outputRootDir(); fs.mkdirSync(imageOutputDir(),{recursive:true}); fs.mkdirSync(videoOutputDir(),{recursive:true});
    const files=[];const visit=current=>{for(const item of fs.readdirSync(current,{withFileTypes:true})){const full=path.join(current,item.name);if(item.isDirectory())visit(full);else if(item.isFile()){const stat=fs.statSync(full),ext=path.extname(item.name).toLowerCase(),relativePath=path.relative(dir,full),url='/api/output/'+relativePath.split(path.sep).map(encodeURIComponent).join('/');files.push({name:item.name,relativePath,path:full,type:['.mp4','.webm','.mov','.mkv'].includes(ext)?'Video':'Ảnh',size:stat.size,modifiedAt:stat.mtime.toISOString(),url})}}};visit(dir);files.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt));
    return respond(res,200,{directory:dir,files});
  }
  if(req.method==='POST' && url.pathname==='/api/choose-output') {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Chọn thư mục lưu kết quả Muse Studio'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}";
    const result=spawnSync('powershell.exe',['-NoProfile','-STA','-Command',script],{encoding:'utf8',windowsHide:false,timeout:120000});
    if(result.error) return respond(res,500,{error:result.error.message});
    const selected=(result.stdout||'').trim(); if(result.status!==0) return respond(res,500,{error:(result.stderr||'Không mở được hộp thoại chọn thư mục.').trim()});
    if(selected){settings.outputDir=path.resolve(selected);persistSettings();}
    return respond(res,200,{cancelled:!selected,outputDir:settings.outputDir});
  }
  if(req.method==='POST' && url.pathname==='/api/open-output') { try { const dir=outputRootDir();fs.mkdirSync(dir,{recursive:true});await openInExplorer(dir);return respond(res,200,{ok:true}); } catch(e) { return respond(res,500,{error:e.message}); } }
  if(req.method==='POST' && url.pathname==='/api/open-image-folder') { try { const dir=imageOutputDir();fs.mkdirSync(dir,{recursive:true});await openInExplorer(dir);return respond(res,200,{ok:true,path:dir}); } catch(e) { return respond(res,500,{error:e.message}); } }
  if(req.method==='POST' && url.pathname==='/api/open-output-file') { try { const data=await bodyJson(req),file=resolveOutputFile(data.relativePath||data.name);if(!file)return respond(res,400,{error:'Đường dẫn file không hợp lệ.'});if(!fs.existsSync(file)||!fs.statSync(file).isFile())return respond(res,404,{error:'Không tìm thấy tệp.'});await openInExplorer(file,true);return respond(res,200,{ok:true}); } catch(e) { return respond(res,500,{error:e.message}); } }
  if(req.method==='POST' && url.pathname==='/api/reveal-output-file') { try { const data=await bodyJson(req),file=resolveOutputFile(data.relativePath||data.name);if(!file)return respond(res,400,{error:'Đường dẫn file không hợp lệ.'});if(!fs.existsSync(file)||!fs.statSync(file).isFile())return respond(res,404,{error:'Không tìm thấy tệp.'});await openInExplorer(path.dirname(file));return respond(res,200,{ok:true}); } catch(e) { return respond(res,500,{error:e.message}); } }
  if(req.method==='POST' && url.pathname==='/api/jobs/bulk-delete') {
    try {
      const data=await bodyJson(req),ids=Array.isArray(data.ids)?Array.from(new Set(data.ids.map(String))):[];
      if(!ids.length)return respond(res,400,{error:'Chưa chọn tác vụ để xóa.'});
      if(ids.length>200)return respond(res,400,{error:'Chỉ xóa tối đa 200 tác vụ mỗi lần.'});
      const removable=new Set(['Trong hàng đợi','Cần xem lại','Cần kết nối Muse','Cần đăng nhập Muse','Lỗi kết nối Muse','Chờ đăng nhập Muse','Lỗi']);
      const deleted=[],skipped=[];
      for(const id of ids){
        let found=false;
        for(const batch of batches.values()){
          const index=batch.jobs.findIndex(job=>job.id===id);if(index<0)continue;
          found=true;const job=batch.jobs[index];
          if(!removable.has(job.status)){skipped.push(id);break;}
          if(job.outputPath){const root=outputRootDir(),target=path.resolve(job.outputPath),relative=path.relative(root,target);if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))return respond(res,400,{error:'File kết quả nằm ngoài thư mục lưu.'});if(fs.existsSync(target))fs.unlinkSync(target);}
          batch.jobs.splice(index,1);deleted.push(id);if(!batch.jobs.length)batches.delete(batch.id);break;
        }
        if(!found)skipped.push(id);
      }
      persistHistory();return respond(res,200,{ok:true,deleted,skipped});
    } catch(e) { return respond(res,500,{error:e.message}); }
  }
  if(req.method==='DELETE' && url.pathname.startsWith('/api/jobs/')) { try { const id=decodeURIComponent(url.pathname.slice('/api/jobs/'.length));let owner=null,index=-1;for(const batch of batches.values()){index=batch.jobs.findIndex(job=>job.id===id);if(index>=0){owner=batch;break}}if(!owner)return respond(res,404,{error:'Không tìm thấy tác vụ.'});const job=owner.jobs[index];if(job.outputPath){const outputRoot=outputRootDir(),target=path.resolve(job.outputPath),relative=path.relative(outputRoot,target);if(relative.startsWith('..')||path.isAbsolute(relative))return respond(res,400,{error:'File kết quả nằm ngoài thư mục lưu.'});if(fs.existsSync(target))fs.unlinkSync(target)}owner.jobs.splice(index,1);if(!owner.jobs.length)batches.delete(owner.id);persistHistory();return respond(res,200,{ok:true}); } catch(e) { return respond(res,500,{error:e.message}); } }
  if(req.method==='GET' && url.pathname==='/api/muse/status') return respond(res,200,museStatus());
  if(req.method==='POST' && url.pathname==='/api/muse/connect') {
    try { const data=await bodyJson(req),id=data.accountId||'default';if(runningBatches.size&&id!==museAccountId)return respond(res,409,{error:'Tài khoản hiện tại còn tác vụ đang chạy. Đợi xong rồi chuyển phiên.'});const result=await connectMuse(id,Boolean(data.hidden));if(result.state==='ready')resumePausedBatches();return respond(res,200,result); }
    catch(e) { museState='error'; return respond(res,500,{state:museState,error:e.message}); }
  }
  if(req.method==='POST' && url.pathname==='/api/batches') {
    try {
      const data=await bodyJson(req), prompts=Array.isArray(data.prompts)?data.prompts:[];
      const valid=prompts.map(x=>typeof x==='string'?{prompt:x.trim()}:({prompt:String(x?.prompt||'').trim(),referenceImage:x?.referenceImage||null})).filter(x=>x.prompt);
      if(!valid.length) return respond(res,400,{error:'Nhập ít nhất một prompt.'});
      if(valid.length>300)return respond(res,400,{error:'Mỗi lượt tối đa 300 prompt.'});
      const types=valid.map(x=>detect(x.prompt));
      if(valid.some((x,i)=>x.referenceImage&&types[i]!=='Video'))return respond(res,400,{error:'Ảnh tham chiếu chỉ dùng cho tác vụ Video.'});
      const referenced=valid.filter(x=>x.referenceImage);
      if(referenced.length>10)return respond(res,400,{error:'Mỗi lượt tối đa 10 ảnh tham chiếu.'});
      for(const item of referenced){
        const ref=item.referenceImage,match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(ref.data||''));
        if(!match||match[1]!==ref.mimeType)return respond(res,400,{error:'Ảnh tham chiếu phải là PNG, JPG hoặc WebP hợp lệ.'});
        const decoded=Buffer.from(match[2],'base64');if(decoded.length>6*1024*1024)return respond(res,400,{error:'Mỗi ảnh tham chiếu tối đa 6 MB.'});if(decoded.toString('base64')!==match[2])return respond(res,400,{error:'Dữ liệu ảnh tham chiếu không hợp lệ.'});
      }
      const workers=1;
      const accountId=accounts.some(a=>a.id===data.accountId&&a.enabled)?data.accountId:(accounts.find(a=>a.primary&&a.enabled)||accounts.find(a=>a.enabled))?.id;
      if(!accountId)return respond(res,400,{error:'Không có tài khoản Muse đang bật.'});
      const batch={id:crypto.randomUUID(),status:'Đang chờ',workers,accountId,createdAt:new Date().toISOString(),jobs:valid.map(item=>{const id=crypto.randomUUID(),type=detect(item.prompt),job={id,prompt:item.prompt,type,status:'Trong hàng đợi'};if(item.referenceImage){const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}[item.referenceImage.mimeType];fs.mkdirSync(REFERENCE_DIR,{recursive:true});job.referenceImagePath=path.join(REFERENCE_DIR,id+ext);job.referenceName=path.basename(String(item.referenceImage.name||'anh-tham-chieu'+ext)).slice(0,180);fs.writeFileSync(job.referenceImagePath,Buffer.from(String(item.referenceImage.data).split(',')[1],'base64'))}return job})};
      batches.set(batch.id,batch); persistHistory();
      queueBatch(batch);
      return respond(res,201,publicBatch(batch));
    } catch(e) { return respond(res,400,{error:e.message}); }
  }
  if(req.method==='GET' && url.pathname.startsWith('/api/batches/')) {
    const id=url.pathname.split('/').pop(), batch=batches.get(id);
    return batch?respond(res,200,publicBatch(batch)):respond(res,404,{error:'Không tìm thấy batch.'});
  }
  if(req.method==='GET' && url.pathname==='/api/history') {
    return respond(res,200,Array.from(batches.values()).reverse().map(publicBatch));
  }
  if(req.method==='GET' && url.pathname.startsWith('/api/output/')) {
    let name=''; try { name=decodeURIComponent(url.pathname.slice('/api/output/'.length)); } catch { return respond(res,400,{error:'Tên file không hợp lệ.'}); }
    const file=resolveOutputFile(name);if(!file) return respond(res,400,{error:'Đường dẫn file không hợp lệ.'});
    if(!fs.existsSync(file)||!fs.statSync(file).isFile()) return respond(res,404,{error:'Không tìm thấy tệp.'});
    const types={'.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska'};
    res.writeHead(200,{'content-type':types[path.extname(file).toLowerCase()]||'application/octet-stream','cache-control':'no-store'});
    return res.end(fs.readFileSync(file));
  }
  if(req.method==='GET') {
    const requested=url.pathname==='/'?'dashboard.html':decodeURIComponent(url.pathname.slice(1));
    if(!['dashboard.html','demo.html'].includes(requested))return respond(res,404,'Not found','text/plain');
    const target=path.join(ROOT,requested);
    if(!fs.existsSync(target)||!fs.statSync(target).isFile()) return respond(res,404,'Not found','text/plain');
    res.writeHead(200, {'content-type':mime[path.extname(target)]||'application/octet-stream','cache-control':'no-store'});
    return res.end(fs.readFileSync(target));
  }
  respond(res,405,{error:'Method not allowed'});
});
server.listen(PORT,'127.0.0.1',()=>{
  console.log(`Muse Batch: http://127.0.0.1:${PORT}`);
  for(const batch of batches.values()){
    if(!['Đang chạy trên Muse','Đang chờ','Tạm dừng: hết hạn mức','Tạm dừng: cần đăng nhập'].includes(batch.status))continue;
    for(const job of batch.jobs)if(['Đang gửi lên Muse','Đang tạo trên Muse'].includes(job.status)){
      job.status='Lỗi';job.error='Máy chủ đã khởi động lại khi tác vụ có thể đã được gửi. Kiểm tra Muse trước khi tạo lại để tránh video trùng.';
    }
    if(batch.jobs.some(j=>j.status==='Trong hàng đợi'))queueBatch(batch);
    else batch.status=batch.jobs.some(j=>j.status==='Lỗi')?'Hoàn tất, có lỗi':'Hoàn tất';
  }
  persistHistory();
});
process.on('SIGINT', async () => {
  if (museContext) await museContext.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

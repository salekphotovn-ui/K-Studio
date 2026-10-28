const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync, spawn, fork } = require('node:child_process');
const { chromium } = require('playwright-core');
const { startLocalApi, finalizeTeamOutput } = require('./local-api');
const { cropToAspect, parseAspectRatio } = require('./media-transform');
const { quotaSnapshot, readMuseQuota } = require('./muse-quota');

const ROOT = __dirname;
const APP_VERSION = require('./package.json').version;
// LOCALAPPDATA may point into an isolated app sandbox instead of the user's data.
const DATA_ROOT = path.resolve(process.env.KSTUDIO_DATA_DIR || path.join(os.homedir(), 'AppData', 'Local', 'K Studio'));
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
const MUSE_LOGIN_VIEWPORT = { width:780, height:530 };
const MUSE_READY_VIEWPORT = { width:1160, height:740 };
const HISTORY_FILE = path.join(DATA_ROOT, 'history.json');
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
const ACCOUNTS_FILE = path.join(DATA_ROOT, 'accounts.json');
const ACCOUNTS_BACKUP_FILE = path.join(DATA_ROOT, 'accounts.backup.json');
const REFERENCE_DIR = path.join(DATA_ROOT, '.uploads', 'references');
const MAX_WORKERS_PER_ACCOUNT = 1;
const DEFAULT_SETTINGS = { outputDir: path.join(DATA_ROOT, 'output'), imageWorkers: 1, videoWorkers: 1, workerCountMode: 'auto', imageTimeout: 6, videoTimeout: 12, promptSeparator: '', allowedDomainsEnabled: true, allowedDomains: 'huggingface.co', autoReservePercent: 5, imageAccountId: '', videoAccountMode: 'all' };
const outputReservations = new Set();
let accounts = [{ id:'default', name:'Tài khoản Muse', enabled:true, primary:true, profileDir:MUSE_PROFILE, createdAt:new Date().toISOString() }];
const accountSources=[ACCOUNTS_FILE,ACCOUNTS_BACKUP_FILE,path.join(ROOT,'accounts.json')].map(source=>{
  try{const saved=JSON.parse(fs.readFileSync(source,'utf8'));return Array.isArray(saved)&&saved.length?{source,saved}:null}catch{return null}
}).filter(Boolean).sort((a,b)=>b.saved.length-a.saved.length);
if(accountSources.length)accounts=accountSources[0].saved;
const initialPrimaryIndex=accounts.findIndex(account=>account.primary);
if(initialPrimaryIndex>0)accounts.unshift(accounts.splice(initialPrimaryIndex,1)[0]);
for(const account of accounts)account.profileDir=account.id==='default'?MUSE_PROFILE:path.join(DATA_ROOT,'.muse-profiles',account.id);
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
function maximumWorkersForAccounts(list=accounts.filter(account=>account.enabled)){return Math.max(1,list.length*MAX_WORKERS_PER_ACCOUNT)}
if(Number(settings.multiLaneVersion||0)<3){
  const capacity=maximumWorkersForAccounts();
  settings.imageWorkers=capacity;
  settings.videoWorkers=capacity;
  settings.workerCountMode='auto';
  settings.multiLaneVersion=3;
  persistSettings();
}
let museContext = null;
let museContextHeadless = false;
let musePage = null;
let museAccountId = 'default';
let museWindowHandle = 0;
let museWindowWatcher = null;
let museConnectPromise = null;
let museState = 'disconnected';
let museQueue = Promise.resolve();
let sideChatCleanup = { status: 'idle', deleted: 0, accountsDone: 0, totalAccounts: 0, currentAccount: null, errors: [] };
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
  fs.writeFileSync(HISTORY_FILE,JSON.stringify(all.filter(b=>b.externalJobId||!['Hoàn tất','Hoàn tất, có lỗi','Lỗi'].includes(b.status)||finished.has(b.id)),null,2),'utf8');
}
function persistSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8'); }
settings.imageWorkers=Math.max(1,Math.min(maximumWorkersForAccounts(),Number(settings.imageWorkers)||DEFAULT_SETTINGS.imageWorkers));
settings.videoWorkers=Math.max(1,Math.min(maximumWorkersForAccounts(),Number(settings.videoWorkers)||DEFAULT_SETTINGS.videoWorkers));
function persistAccounts() {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE),{recursive:true});
  const serialized=JSON.stringify(accounts,null,2);
  const writeAtomic=file=>{
    const tempFile=`${file}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile,serialized,'utf8');
    fs.renameSync(tempFile,file);
  };
  if(fs.existsSync(ACCOUNTS_FILE)){
    try{
      const previous=JSON.parse(fs.readFileSync(ACCOUNTS_FILE,'utf8'));
      if(Array.isArray(previous)&&previous.length)fs.copyFileSync(ACCOUNTS_FILE,ACCOUNTS_BACKUP_FILE);
    }catch{}
  }
  writeAtomic(ACCOUNTS_FILE);
  const legacyFile=path.join(ROOT,'accounts.json');
  if(path.resolve(legacyFile)!==path.resolve(ACCOUNTS_FILE))try{writeAtomic(legacyFile)}catch(error){console.error('Không đồng bộ được bản tài khoản dự phòng trong thư mục K Studio:',error.message)}
}
persistAccounts();
let quotaReadQueue = Promise.resolve();
function refreshAccountQuota(page, account) {
  const task = quotaReadQueue.then(async () => {
    const usage = await readMuseQuota(page);
    if (!usage) return null;
    account.quotaUsedPct = usage.percent;
    account.quotaObservedAt = new Date().toISOString();
    account.quotaResetLabel = usage.resetLabel;
    account.additionalTokensLabel = usage.additionalTokensLabel;
    persistAccounts();
    return usage.percent;
  });
  quotaReadQueue = task.catch(() => {});
  return task;
}
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
function replyAfterPrompt(text,prompt){
  const content=String(text||'').replace(/\s+/g,' '),needle=String(prompt||'').replace(/\s+/g,' ').trim();
  if(!needle)return null;
  const index=content.lastIndexOf(needle);
  return index<0?null:content.slice(index+needle.length);
}
function checkQuotaReply(text,oldText,prompt){
  const newer=replyAfterPrompt(text,prompt);
  if(newer===null)return;
  const reason=quotaMessage(newer);
  if(reason){const error=new Error('Muse báo hết token hoặc hạn mức.');error.code='MUSE_QUOTA';error.reason=reason;throw error;}
}
function checkMuseGenerationFailure(text,oldText,prompt){
  const failurePattern=/(?:something went wrong|generation failed|failed to generate|please try again later|temporarily unavailable|không thể tạo|tạo nội dung thất bại|đã xảy ra lỗi)/i;
  const newer=replyAfterPrompt(text,prompt);
  if(newer===null)return;
  const failure=newer.match(failurePattern);
  if(failure){
    // Preserve Muse's visible explanation so the queue tells us why generation
    // failed instead of reducing every failure to the same generic message.
    const detail=newer.slice(failure.index,Math.min(newer.length,failure.index+300)).trim();
    const error=new Error(`Muse báo lỗi tạo nội dung${detail?`: ${detail}`:''}. K Studio có thể thử lại trong cùng chat.`);
    error.code='MUSE_GENERATION_FAILED';
    throw error;
  }
}
function accountAvailable(account){const blocked=Date.parse(account.quotaBlockedAt||'');return account.enabled && (!Number.isFinite(blocked)||Date.now()-blocked>=QUOTA_RECHECK_MS);}
function accountsForType(type){
  const enabled=accounts.filter(account=>account.enabled);
  if(type==='Ảnh'&&settings.imageAccountId){const preferred=enabled.find(account=>account.id===settings.imageAccountId);return preferred?[preferred,...enabled.filter(account=>account.id!==preferred.id)]:enabled}
  if(type==='Video'&&settings.videoAccountMode==='exclude-image-account'&&settings.imageAccountId)return enabled.filter(account=>account.id!==settings.imageAccountId);
  return enabled;
}
function accountHasSavedSession(account){
  const profile=account.profileDir||path.join(DATA_ROOT,'.muse-profiles',account.id);
  return fs.existsSync(path.join(profile,'Default','Network','Cookies'))||fs.existsSync(path.join(profile,'Default','Cookies'));
}
function workerCapacityForType(type){return Math.max(1,accountsForType(type).filter(account=>accountAvailable(account)&&(accountHasSavedSession(account)||(museState==='ready'&&museAccountId===account.id))).length*MAX_WORKERS_PER_ACCOUNT)}
function syncAutomaticWorkerCapacity(){
  if(settings.workerCountMode!=='auto')return;
  settings.imageWorkers=workerCapacityForType('Ảnh');
  settings.videoWorkers=workerCapacityForType('Video');
  persistSettings();
}
function quotaCostBuffer(account,type){return type==='Video'?Math.max(4,Number(account.videoCostBufferPct)||0):Math.max(1,Number(account.imageCostBufferPct)||0)}
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
  await stopMuseWindowWatcher();
  const stale = museContext;
  museContext = null;
  museContextHeadless = false;
  musePage = null;
  museWindowHandle = 0;
  museState = 'disconnected';
  if (stale) await stale.close().catch(() => {});
}

function respond(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, {'content-type': type, 'cache-control':'no-store'});
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function outputRootDir(){const configured=path.resolve(settings.outputDir||DEFAULT_SETTINGS.outputDir);return path.basename(configured).toLowerCase()==='images'?path.dirname(configured):configured}
function outputFileForDeletion(value){
  const root=outputRootDir(),target=path.resolve(String(value||'')),relative=path.relative(root,target);
  if(!value||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('File kết quả nằm ngoài thư mục lưu.');
  if(!fs.existsSync(target))return null;
  const rootReal=fs.realpathSync(root),targetReal=fs.realpathSync(target),realRelative=path.relative(rootReal,targetReal);
  if(realRelative==='..'||realRelative.startsWith(`..${path.sep}`)||path.isAbsolute(realRelative))throw new Error('File kết quả nằm ngoài thư mục lưu.');
  if(!fs.statSync(targetReal).isFile())throw new Error('Chỉ có thể xóa file kết quả, không xóa thư mục.');
  return target;
}
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
  return {id:batch.id,status:batch.status,active:runningBatches.has(batch.id)||scheduledBatches.has(batch.id),workers:batch.workers,accountId:batch.accountId||'default',activeAccountId:batch.activeAccountId||null,createdAt:batch.createdAt,jobs:batch.jobs.map(j=>{let outputSize=null,outputRelativePath=null;try{if(j.outputPath){outputRelativePath=path.relative(root,path.resolve(j.outputPath));if(fs.existsSync(j.outputPath))outputSize=fs.statSync(j.outputPath).size}}catch{}const outputUrl=outputRelativePath?'/api/output/'+outputRelativePath.split(path.sep).map(encodeURIComponent).join('/'):null;return{id:j.id,prompt:j.prompt,type:j.type,status:j.status,error:j.error||null,accountId:j.accountId||null,outputPath:j.outputPath||null,outputRelativePath,outputUrl,outputSize,hasReferenceImage:Boolean(j.referenceImagePath),referenceName:j.referenceName||null,startedAt:j.startedAt||null,finishedAt:j.finishedAt||null,quotaBeforePct:j.quotaBeforePct??null,quotaAfterPct:j.quotaAfterPct??null,quotaDeltaPct:j.quotaDeltaPct??null}})};
}
async function runBatch(batch) {
  batch.status = 'Cần kết nối Muse';
  for (const job of batch.jobs) job.status = 'Cần kết nối Muse';
  persistHistory();
}
async function launchMuseContext(profile, headless, hidden) {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME_PATH,
    headless,
    viewport: MUSE_LOGIN_VIEWPORT,
    ...(!headless ? { args: ['--window-size=800,600', ...(hidden ? ['--window-position=-32000,-32000','--start-minimized'] : [])] } : {}),
    acceptDownloads: true,
  });
  museContext = context;
  museContextHeadless = headless;
  if (hidden && !headless) startMuseWindowWatcher(profile);
  context.on('close', () => {
    if (museContext === context) {
      stopMuseWindowWatcher().catch(() => {});
      museContext = null;
      museContextHeadless = false;
      musePage = null;
      museWindowHandle = 0;
      museState = 'disconnected';
    }
  });
}
async function connectMuse(accountId='default', hidden=false) {
  if (museConnectPromise) return museConnectPromise;
  museConnectPromise = (async () => {
    const account=accounts.find(a=>a.id===accountId);
    if(!account||!account.enabled) throw new Error('Tài khoản không tồn tại hoặc đã tắt.');
    if (museContext && !museContextIsAlive()) await discardStaleMuseContext();
    if(museContext && museContext.pages().length && museAccountId!==accountId) await discardStaleMuseContext();
    if(museContext && museContextHeadless && !hidden) await discardStaleMuseContext();
    if (!museContext || museContext.pages().length === 0) {
      if(!CHROME_PATH)throw new Error('Không tìm thấy Google Chrome trên máy. Hãy cài Chrome hoặc đặt KSTUDIO_CHROME_PATH.');
      const profile=accountId==='default'?MUSE_PROFILE:path.join(DATA_ROOT,'.muse-profiles',accountId);
      fs.mkdirSync(profile,{recursive:true}); account.profileDir=profile;
      await launchMuseContext(profile, hidden && accountHasSavedSession(account), hidden);
    }
    museAccountId=accountId;
    musePage = museContext.pages()[0] || await museContext.newPage();
    if (!hidden && !museContextHeadless) await setMuseWindowState('normal');
    if(!/^https?:\/\/(www\.)?muse\.ai\//i.test(musePage.url())) await musePage.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' });
    await musePage.waitForTimeout(1500);
    museState = await isMuseReady(musePage) ? 'ready' : 'login_required';
    await musePage.setViewportSize(museState==='ready'?MUSE_READY_VIEWPORT:MUSE_LOGIN_VIEWPORT);
    if (museState === 'ready') await refreshAccountQuota(musePage, account);
    if (museState === 'login_required' && museContextHeadless) {
      // A saved profile can expire. Reopen only that account with a visible
      // window so the user can log in without a taskbar flash on healthy runs.
      await discardStaleMuseContext();
      await launchMuseContext(account.profileDir, false, false);
      museAccountId=accountId;
      musePage=museContext.pages()[0] || await museContext.newPage();
      await musePage.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' });
      museState='login_required';
    }
    const windowState=hidden && museState==='ready' ? 'hidden' : 'normal';
    if (!await setMuseWindowState(windowState)) throw new Error(windowState==='hidden'?'Không ẩn được cửa sổ Muse; đã dừng trước khi gửi tác vụ.':'Không hiện được cửa sổ Muse để đăng nhập.');
    return museStatus();
  })();
  try { return await museConnectPromise; }
  finally { museConnectPromise = null; }
}
async function setMuseWindowState(windowState) {
  if(!museContext) return false;
  if(museContextHeadless) return windowState==='hidden';
  try {
    const account=accounts.find(a=>a.id===museAccountId);
    if(!account)return false;
    const profile=museAccountId==='default'?MUSE_PROFILE:path.join(DATA_ROOT,'.muse-profiles',museAccountId);
    if(windowState!=='hidden')await stopMuseWindowWatcher();
    const ready=museState==='ready';
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'muse-window.ps1'),windowState==='hidden'?'hide':'show',profile,String(museWindowHandle),'0',String(ready?1180:800),String(ready?850:600)],{windowsHide:true,encoding:'utf8',timeout:12000,maxBuffer:8192});
    if(result.status!==0)throw new Error((result.stderr||result.error?.message||'Không đổi được trạng thái cửa sổ Muse.').trim());
    const state=JSON.parse(result.stdout.trim());
    if(!state.ok||Boolean(state.visible)===(windowState==='hidden'))return false;
    museWindowHandle=state.handle;
    if(windowState==='hidden')startMuseWindowWatcher(profile);
    return true;
  } catch(error) { console.error('Muse window:',error.message);return false; }
}
async function stopMuseWindowWatcher() {
  const watcher=museWindowWatcher;
  museWindowWatcher=null;
  if(!watcher||watcher.child.exitCode!==null)return;
  await new Promise(resolve=>{
    const timer=setTimeout(resolve,1500);
    watcher.child.once('exit',()=>{clearTimeout(timer);resolve()});
    watcher.child.kill();
  });
}
function startMuseWindowWatcher(profile) {
  if(museWindowWatcher?.profile===profile&&museWindowWatcher.child.exitCode===null&&!museWindowWatcher.child.killed)return;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'muse-window.ps1'),'watch',profile,'0',String(process.pid)],{windowsHide:true,stdio:'ignore'});
  museWindowWatcher={child,profile};
  child.once('error',error=>console.error('Muse window watch:',error.message));
  child.once('exit',code=>{if(museWindowWatcher?.child===child)museWindowWatcher=null;if(code&&code!==0)console.error('Muse window watch exited:',code)});
  child.unref();
}
async function isMuseReady(page) {
  try { await page.getByRole('textbox', { name: /Message/i }).first().waitFor({state:'visible',timeout:15000}); return true; }
  catch { return false; }
}
function museStatus() {
  return { state: museState, url: musePage?.url() || null, title: musePage ? 'Muse' : null, accountId:museAccountId, viewport:musePage?.viewportSize()||null };
}
let museLoginWatchBusy=false;
async function watchMuseLogin() {
  if(museLoginWatchBusy||museState!=='login_required'||!museContextIsAlive()||!musePage||musePage.isClosed())return;
  museLoginWatchBusy=true;
  try {
    if(!await musePage.getByRole('textbox',{name:/Message/i}).first().isVisible().catch(()=>false))return;
    museState='ready';
    await musePage.setViewportSize(MUSE_READY_VIEWPORT);
    const account=accounts.find(a=>a.id===museAccountId);
    if(account)await refreshAccountQuota(musePage,account);
    syncAutomaticWorkerCapacity();
    if(!await setMuseWindowState('hidden'))throw new Error('Không ẩn được cửa sổ Muse sau khi đăng nhập.');
    resumePausedBatches();
  } catch(error) { museState='error';console.error('Muse login watch:',error.message); }
  finally { museLoginWatchBusy=false; }
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
async function museResponseForPrompt(page,prompt) {
  return page.evaluate(prompt=>{
    const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
    const needle=normalize(prompt);
    const containers=[...document.querySelectorAll('[class*="max-w-3xl"]')];
    for(const container of containers){
      const rows=[...container.children];
      let promptIndex=-1;
      for(let index=0;index<rows.length;index++){
        const text=normalize(rows[index].innerText);
        if(text.startsWith('You:')&&text.includes(needle))promptIndex=index;
      }
      if(promptIndex<0)continue;
      let end=rows.length;
      for(let index=promptIndex+1;index<rows.length;index++)if(normalize(rows[index].innerText).startsWith('You:')){end=index;break}
      const replies=rows.slice(promptIndex+1,end);
      const buttons=replies.flatMap(row=>[...row.querySelectorAll('button[aria-label]')]);
      const allImages=[...document.querySelectorAll('button[aria-label^="Open generated image"]')];
      const allVideos=[...document.querySelectorAll('button[aria-label^="Open generated video"],button[aria-label^="Open animated video"]')];
      const allVideoDownloads=[...document.querySelectorAll('button[aria-label="Download video"]')];
      const image=buttons.filter(button=>allImages.includes(button)).at(-1);
      const video=buttons.filter(button=>allVideos.includes(button)).at(-1);
      const directVideo=buttons.filter(button=>allVideoDownloads.includes(button)).at(-1);
      return {matched:true,replyText:replies.map(row=>row.innerText||'').join('\n').slice(0,3000),imageIndex:image?allImages.indexOf(image):-1,videoIndex:video?allVideos.indexOf(video):-1,directVideoIndex:directVideo?allVideoDownloads.indexOf(directVideo):-1};
    }
    return {matched:false,replyText:'',imageIndex:-1,videoIndex:-1,directVideoIndex:-1};
  },prompt);
}
function checkScopedMuseError(response){
  const reason=quotaMessage(response.replyText);
  if(reason){const error=new Error('Muse báo hết token hoặc hạn mức.');error.code='MUSE_QUOTA';error.reason=reason;throw error}
  const match=response.replyText.match(/(?:something went wrong|generation failed|failed to generate|please try again later|temporarily unavailable|không thể tạo|không tạo được|gặp trục trặc khi tạo|thử lại sau một chút|tạo nội dung thất bại|đã xảy ra lỗi)/i);
  if(match){const error=new Error(`Muse báo lỗi tạo nội dung: ${response.replyText.slice(match.index,match.index+300).trim()}`);error.code='MUSE_GENERATION_FAILED';throw error}
}
async function waitForMuseResult(page,prompt,type,timeoutMs){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    const response=await museResponseForPrompt(page,prompt);
    if(response.matched){checkScopedMuseError(response);if(type==='Ảnh'?response.imageIndex>=0:(response.videoIndex>=0||response.directVideoIndex>=0))return response}
    await page.waitForTimeout(1200);
  }
  throw new Error(`Muse chưa hiện ${type.toLowerCase()} gắn với prompt này trong thời gian chờ tối đa.`);
}
async function downloadLatestImage(page, prompt) {
  const response=await museResponseForPrompt(page,prompt);
  if(!response.matched||response.imageIndex<0)throw new Error('Không tìm thấy ảnh nằm trong phản hồi của prompt này.');
  await page.getByRole('button', { name: /Open generated image/i }).nth(response.imageIndex).click();
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
async function downloadLatestVideo(page, prompt, timeoutMs = 15000) {
  const response=await museResponseForPrompt(page,prompt);
  if(!response.matched||(response.videoIndex<0&&response.directVideoIndex<0))throw new Error('Không tìm thấy video nằm trong phản hồi của prompt này.');
  let downloadButton;
  const openedDialog=response.directVideoIndex<0;
  if(response.directVideoIndex>=0)downloadButton=page.locator('button[aria-label="Download video"]').nth(response.directVideoIndex);
  else{
    const generated = page.getByRole('button', { name: /Open (?:generated|animated) video/i });
    await generated.nth(response.videoIndex).click();
    downloadButton=page.getByRole('button', { name: /Download/i }).last();
  }
  await downloadButton.waitFor({ state: 'visible', timeout: Math.max(1000,timeoutMs) });
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await downloadButton.click();
  const download = await downloadPromise;
  const ext = path.extname(download.suggestedFilename()) || '.mp4';
  const target=reserveOutputPath(prompt,ext,'Video');
  try{await download.saveAs(target)}finally{outputReservations.delete(target)}
  if(openedDialog){const close = page.getByRole('button', { name: 'Close' });if (await close.count()) await close.last().click().catch(() => {});}
  return target;
}
const activeAccountJobs=new Map();
const activeWorkerChildren=new Set();
function cleanSideChatsForAccount(account){
  return new Promise(resolve=>{
    const child=fork(path.join(ROOT,'muse-cleanup-worker.js'),[],{silent:true});
    activeWorkerChildren.add(child);
    let settled=false,stderr='';
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);activeWorkerChildren.delete(child);resolve(result)};
    const timer=setTimeout(()=>{child.kill();finish({ok:false,error:'Dọn chat phụ quá thời gian chờ.'})},20*60_000);
    child.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-1000)});
    child.once('error',error=>finish({ok:false,error:error.message}));
    child.once('exit',code=>finish({ok:false,error:stderr||`Tiến trình dọn chat kết thúc với mã ${code}.`}));
    child.on('message',message=>{
      if(message?.kind==='progress'){sideChatCleanup.deleted++;return}
      finish(message);
    });
    child.send({profileDir:account.profileDir,chromePath:CHROME_PATH});
  });
}
async function cleanAllSideChats(){
  try{
    await discardStaleMuseContext();
    const list=accounts.filter(account=>accountHasSavedSession(account));
    sideChatCleanup.totalAccounts=list.length;
    for(const account of list){
      sideChatCleanup.currentAccount=account.name;
      const result=await cleanSideChatsForAccount(account);
      if(result?.ok){account.sideChatUrls=[];persistAccounts()}
      else sideChatCleanup.errors.push({account:account.name,error:result?.error||'Không rõ lỗi.'});
      sideChatCleanup.accountsDone++;
    }
    sideChatCleanup.currentAccount=null;
    sideChatCleanup.status=sideChatCleanup.errors.length?'complete-with-errors':'complete';
    sideChatCleanup.finishedAt=new Date().toISOString();
  }catch(error){sideChatCleanup.currentAccount=null;sideChatCleanup.status='failed';sideChatCleanup.errors.push({account:'K Studio',error:error.message});sideChatCleanup.finishedAt=new Date().toISOString()}
}
function runMuseTaskProcess(account,job){
  return new Promise((resolve,reject)=>{
    const child=fork(path.join(ROOT,'muse-task-worker.js'),[],{silent:true});
    activeWorkerChildren.add(child);
    let stderr='';
    child.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000)});
    const hardTimeout=((job.type==='Ảnh'?settings.imageTimeout:settings.videoTimeout)+2)*60_000;
    const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('Tiến trình Muse vượt quá thời gian chờ.'),{code:'MUSE_WORKER_TIMEOUT'}))},hardTimeout);
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);activeWorkerChildren.delete(child);error?reject(error):resolve(result)};
    child.once('error',finish);
    child.once('exit',code=>{if(!settled)finish(Object.assign(new Error(stderr||`Tiến trình Muse dừng với mã ${code}.`),{code:'MUSE_WORKER_EXIT'}))});
    child.once('message',result=>{
      if(result?.ok)return finish(null,result);
      finish(Object.assign(new Error(result?.error||'Muse không trả kết quả.'),{code:result?.code||'KSTUDIO_ERROR'}));
    });
    const lane=Number.isInteger(job.lane)?job.lane:0;
    child.send({root:ROOT,chromePath:CHROME_PATH,profileDir:account.profileDir,chatUrl:'https://muse.ai/',prompt:job.prompt,type:job.type,referenceImagePath:job.referenceImagePath||null,timeoutMs:(job.type==='Ảnh'?settings.imageTimeout:settings.videoTimeout)*60_000,tempDir:path.join(DATA_ROOT,'.downloads'),jobId:job.id});
  });
}
function applyWorkerQuota(account,quota){
  if(!quota||!Number.isFinite(Number(quota.percent)))return;
  account.quotaUsedPct=Number(quota.percent);account.quotaObservedAt=new Date().toISOString();account.quotaResetLabel=quota.resetLabel||null;account.additionalTokensLabel=quota.additionalTokensLabel||null;persistAccounts();
}
async function storeWorkerResult(job,tempPath){
  if(!tempPath||!fs.existsSync(tempPath))throw new Error('Muse hoàn tất nhưng không tìm thấy file tải xuống.');
  const target=reserveOutputPath(job.prompt,path.extname(tempPath)||(job.type==='Ảnh'?'.webp':'.mp4'),job.type);
  try{fs.copyFileSync(tempPath,target);fs.unlinkSync(tempPath);job.outputPath=target}
  finally{outputReservations.delete(target)}
  job.outputPath=await cropToAspect(job.outputPath,job.type,parseAspectRatio(job.aspectRatio));
  finalizeTeamOutput(job);
}
async function runMuseBatch(batch) {
  batch.status='Đang chạy trên Muse';batch.error=null;
  try{
    if(museContext)await discardStaleMuseContext();
    for(const job of batch.jobs)if(job.type==='Cần xem lại'){job.status='Cần xem lại';job.error='Thêm tiền tố Ảnh: hoặc Video: để xác định loại tác vụ.'}
    const presentTypes=['Ảnh','Video'].filter(type=>batch.jobs.some(job=>job.type===type&&job.status==='Trong hàng đợi'));
    for(const type of presentTypes){
      if(batch.cancelRequested)break;
      const pending=batch.jobs.filter(job=>job.type===type&&job.status==='Trong hàng đợi');
      const eligible=accountsForType(type).filter(account=>accountAvailable(account)&&(accountHasSavedSession(account)||(museState==='ready'&&museAccountId===account.id))&&(!batch.strictAccount||account.id===batch.accountId));
      const start=Math.max(0,eligible.findIndex(account=>account.id===batch.accountId));
      const ordered=start>0?[...eligible.slice(start),...eligible.slice(0,start)]:eligible;
      const configured=settings.workerCountMode==='auto'?workerCapacityForType(type):(type==='Ảnh'?settings.imageWorkers:settings.videoWorkers);
      const requested=presentTypes.length===1?(batch.workers||configured):configured;
      const slots=Math.min(workerCapacityForType(type),requested,pending.length);
      const pool=ordered.slice(0,Math.min(ordered.length,slots));
      if(!pool.length){batch.status='Tạm dừng: thiếu tài khoản phù hợp';batch.error=type==='Ảnh'?'Không có tài khoản Muse đang bật để tạo ảnh.':'Không có tài khoản Muse phù hợp để tạo video.';persistHistory();return}
      const laneCounts=pool.map(()=>1);
      batch.workers=laneCounts.reduce((sum,count)=>sum+count,0);batch.activeAccountId=pool[0].id;
      let cursor=0;
      async function accountLoop(account,index,lanes){
        while(!batch.cancelRequested){
          if(!accountAvailable(account))break;
          const tasks=[];
          for(let lane=0;lane<lanes;lane++){
            const job=pending[cursor++];if(!job)break;
            if(job.status!=='Trong hàng đợi')continue;
            if(job.outputPath&&fs.existsSync(job.outputPath)&&job.teamOutputBase){job.outputPath=await cropToAspect(job.outputPath,job.type,parseAspectRatio(job.aspectRatio));finalizeTeamOutput(job);job.status='Hoàn tất';job.error=null;job.finishedAt=new Date().toISOString();persistHistory();continue}
            job.status='Đang tạo trên Muse';job.accountId=account.id;job.startedAt=new Date().toISOString();job.worker=laneCounts.slice(0,index).reduce((sum,count)=>sum+count,0)+lane+1;job.lane=lane;job.promptSent=true;job.error=null;job.errorCode=null;tasks.push({job,lane});
          }
          if(!tasks.length){if(cursor>=pending.length)break;continue}
          activeAccountJobs.set(account.id,tasks.map(({job})=>job.id));persistHistory();
          try{
            const results=[{jobId:tasks[0].job.id,lane:0,ok:true,...await runMuseTaskProcess(account,{...tasks[0].job,lane:0})}];
            for(const {job,lane} of tasks){
              const result=results.find(item=>item.jobId===job.id);
              if(!result?.ok){
                const error=Object.assign(new Error(result?.error||'Muse không trả kết quả.'),{code:result?.code||'KSTUDIO_ERROR'});
                if(error.code==='MUSE_QUOTA'){account.quotaBlockedAt=new Date().toISOString();account.quotaReason=error.message;persistAccounts()}
                const retryable=['MUSE_GENERATION_FAILED','MUSE_QUOTA','MUSE_LOGIN_REQUIRED','MUSE_WORKER_TIMEOUT','MUSE_WORKER_EXIT'].includes(error.code);
                if(retryable&&!batch.cancelRequested&&(job.retryCount||0)<(batch.maxRetries||0)){job.retryCount=(job.retryCount||0)+1;job.status='Trong hàng đợi';job.error=null;job.errorCode=null;job.startedAt=null;job.accountId=null;job.promptSent=false;pending.push(job)}
                else{job.status='Lỗi';job.error=error.message;job.errorCode=error.code}
                continue;
              }
              try{await storeWorkerResult(job,result.tempPath);applyWorkerQuota(account,result.quota);job.status='Hoàn tất';job.error=null;job.errorCode=null;job.finishedAt=new Date().toISOString()}
              catch(error){job.status='Lỗi';job.error=error.message;job.errorCode=error.code||'KSTUDIO_ERROR'}
            }
          }finally{activeAccountJobs.delete(account.id);persistHistory()}
        }
      }
      await Promise.all(pool.map((account,index)=>accountLoop(account,index,laneCounts[index])));
    }
    if(batch.cancelRequested){for(const job of batch.jobs)if(job.status==='Trong hàng đợi')job.status='Đã hủy';batch.status='Đã hủy'}
    else if(batch.jobs.some(job=>job.status==='Trong hàng đợi')){batch.status='Tạm dừng: cần đăng nhập';batch.error='Một số tài khoản chưa đăng nhập hoặc không còn khả dụng.'}
    else batch.status=batch.jobs.some(job=>job.status==='Lỗi')?'Hoàn tất, có lỗi':'Hoàn tất';
    persistHistory();
  }catch(error){batch.status='Lỗi kết nối Muse';batch.error=error.message;persistHistory()}
}
let localApiControl=null;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET' && url.pathname==='/api/side-chat-cleanup')return respond(res,200,sideChatCleanup);
  if(req.method==='POST' && url.pathname==='/api/side-chat-cleanup'){
    if(![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(req.headers.origin))return respond(res,403,{error:'Chỉ thao tác từ giao diện K Studio trên máy này.'});
    if(sideChatCleanup.status==='running')return respond(res,409,{error:'Đang dọn chat phụ.'});
    if(runningBatches.size||scheduledBatches.size)return respond(res,409,{error:'Đợi hàng đợi K Studio chạy xong rồi dọn chat phụ.'});
    sideChatCleanup={status:'running',deleted:0,accountsDone:0,totalAccounts:0,currentAccount:null,errors:[],startedAt:new Date().toISOString()};
    museQueue=museQueue.then(cleanAllSideChats,cleanAllSideChats);
    return respond(res,202,sideChatCleanup);
  }
  if(req.method==='GET' && url.pathname==='/api/health') return respond(res,200,{ok:true,mode:'local',museConnected:museState==='ready'});
  if(req.method==='GET' && url.pathname==='/api/version') return respond(res,200,{version:'kstudio-localdata-v53',appVersion:APP_VERSION,dataRoot:DATA_ROOT});
  if(req.method==='GET' && url.pathname==='/api/local-api/status') return respond(res,200,localApiControl?.status()||{enabled:false,listening:false,error:'API cục bộ chưa khởi động.'});
  if(req.method==='POST' && (url.pathname==='/api/local-api/reveal'||url.pathname==='/api/local-api/rotate')) {
    const origin=req.headers.origin;
    if(![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(origin))return respond(res,403,{error:'Chỉ thao tác từ giao diện K Studio trên máy này.'});
    if(!localApiControl)return respond(res,503,{error:'API cục bộ chưa khởi động.'});
    try{return url.pathname.endsWith('/reveal')?respond(res,200,{apiKey:localApiControl.reveal()}):respond(res,200,localApiControl.rotate())}
    catch(e){return respond(res,500,{error:e.message})}
  }
  if(req.method==='GET' && url.pathname==='/api/settings') {if(settings.workerCountMode==='auto'){settings.imageWorkers=workerCapacityForType('Ảnh');settings.videoWorkers=workerCapacityForType('Video')}return respond(res,200,settings)}
  if(req.method==='GET' && url.pathname==='/api/accounts') return respond(res,200,{activeId:museAccountId,state:museState,accounts:accounts.map(a=>({id:a.id,name:a.name,enabled:a.enabled,primary:a.primary,open:activeAccountJobs.has(a.id)||!!(museContext&&museAccountId===a.id),session:activeAccountJobs.has(a.id)?'Đang chạy':museAccountId===a.id?museState:'Chưa mở',quotaBlocked:!accountAvailable(a)&&a.enabled,quotaBlockedAt:a.quotaBlockedAt||null,quotaReason:a.quotaReason||null,quotaRetryAt:a.quotaBlockedAt?new Date(Date.parse(a.quotaBlockedAt)+QUOTA_RECHECK_MS).toISOString():null,...quotaSnapshot(a),jobs:Array.from(batches.values()).reduce((n,b)=>n+b.jobs.filter(j=>(j.accountId||b.accountId)===a.id).length,0)}))});
  if(req.method==='POST' && url.pathname==='/api/accounts') {
    try { const data=await bodyJson(req),name=String(data.name||'').trim();if(!name)return respond(res,400,{error:'Nhập tên tài khoản.'});const account={id:crypto.randomUUID().replace(/-/g,''),name,enabled:true,primary:false,profileDir:path.join(ROOT,'.muse-profiles'),createdAt:new Date().toISOString(),sideChatUrls:[]};accounts.push(account);syncAutomaticWorkerCapacity();persistAccounts();return respond(res,201,{id:account.id,name:account.name,enabled:account.enabled,primary:account.primary,open:false,session:'Chưa đăng nhập'}); } catch(e){return respond(res,400,{error:e.message});}
  }
  if(req.method==='POST' && url.pathname.startsWith('/api/accounts/') && url.pathname.endsWith('/open')) {
    if(sideChatCleanup.status==='running')return respond(res,409,{error:'Đang dọn chat phụ; đợi xong rồi mở tài khoản.'});
    const id=url.pathname.split('/')[3];if(runningBatches.size&&id!==museAccountId)return respond(res,409,{error:'Tài khoản hiện tại còn tác vụ đang chạy. Đợi xong rồi chuyển phiên.'});try{const result=await connectMuse(id);if(result.state==='ready'){syncAutomaticWorkerCapacity();resumePausedBatches()}return respond(res,200,result);}catch(e){museState='error';return respond(res,500,{state:museState,error:e.message});}
  }
  if(req.method==='POST' && url.pathname.startsWith('/api/accounts/') && url.pathname.endsWith('/retry-quota')) {
    const id=url.pathname.split('/')[3],account=accounts.find(a=>a.id===id);if(!account)return respond(res,404,{error:'Không tìm thấy tài khoản.'});
    delete account.quotaBlockedAt;delete account.quotaReason;persistAccounts();resumePausedBatches();return respond(res,200,{ok:true});
  }
  if(req.method==='PUT' && url.pathname.startsWith('/api/accounts/')) {
    const id=url.pathname.split('/')[3],account=accounts.find(a=>a.id===id);if(!account)return respond(res,404,{error:'Không tìm thấy tài khoản.'});
      try{const data=await bodyJson(req);if(data.name!==undefined){const name=String(data.name).trim();if(!name)return respond(res,400,{error:'Tên tài khoản không được để trống.'});account.name=name}if(data.enabled!==undefined){if(!data.enabled&&runningBatches.size&&museAccountId===id)return respond(res,409,{error:'Tài khoản còn tác vụ đang chạy.'});account.enabled=Boolean(data.enabled);if(!account.enabled&&accounts.filter(a=>a.enabled).length===0)return respond(res,400,{error:'Cần giữ ít nhất một tài khoản đang bật.'});if(!account.enabled&&account.primary){account.primary=false;const next=accounts.find(a=>a.enabled);if(next)next.primary=true}if(!account.enabled&&museAccountId===id&&museContext){await museContext.close().catch(()=>{});museContext=null;musePage=null;museState='disconnected'}}if(data.primary){if(!account.enabled)return respond(res,400,{error:'Hãy bật tài khoản trước.'});for(const a of accounts)a.primary=false;account.primary=true;const index=accounts.indexOf(account);if(index>0){accounts.splice(index,1);accounts.unshift(account)}}if(data.move){const from=accounts.indexOf(account),to=Math.max(0,Math.min(accounts.length-1,from+Number(data.move)));accounts.splice(from,1);accounts.splice(to,0,account)}syncAutomaticWorkerCapacity();persistAccounts();if(data.enabled)resumePausedBatches();return respond(res,200,{id:account.id,name:account.name,enabled:account.enabled,primary:account.primary,open:museAccountId===id&&!!museContext,session:museAccountId===id?museState:'Chưa mở'});}catch(e){return respond(res,400,{error:e.message});}
  }
  if(req.method==='DELETE' && url.pathname.startsWith('/api/accounts/')) {
    const id=url.pathname.split('/')[3];if(Array.from(batches.values()).some(b=>b.accountId===id&&!['Hoàn tất','Hoàn tất, có lỗi','Lỗi kết nối Muse','Chờ đăng nhập Muse','Lỗi'].includes(b.status)))return respond(res,409,{error:'Tài khoản còn tác vụ đang chạy.'});if(accounts.length<=1)return respond(res,400,{error:'Phải giữ lại ít nhất một tài khoản.'});const index=accounts.findIndex(a=>a.id===id);if(index<0)return respond(res,404,{error:'Không tìm thấy tài khoản.'});if(museAccountId===id&&museContext){await museContext.close().catch(()=>{});museContext=null;musePage=null;museState='disconnected';}accounts.splice(index,1);if(!accounts.some(a=>a.primary))accounts[0].primary=true;if(settings.imageAccountId===id){settings.imageAccountId='';persistSettings()}syncAutomaticWorkerCapacity();persistAccounts();return respond(res,200,{ok:true});
  }
  if(req.method==='PUT' && url.pathname==='/api/settings') {
    try {
      const data=await bodyJson(req);
      if(data.outputDir!==undefined) { const p=path.resolve(String(data.outputDir)); if(!path.isAbsolute(p)) return respond(res,400,{error:'Thư mục lưu không hợp lệ.'}); settings.outputDir=p; }
      if(data.imageWorkers!==undefined){const next=Math.max(1,Math.min(maximumWorkersForAccounts(accountsForType('Ảnh')),Number(data.imageWorkers)||1));if(next!==Number(settings.imageWorkers))settings.workerCountMode='manual';settings.imageWorkers=next}
      if(data.videoWorkers!==undefined){const next=Math.max(1,Math.min(maximumWorkersForAccounts(accountsForType('Video')),Number(data.videoWorkers)||1));if(next!==Number(settings.videoWorkers))settings.workerCountMode='manual';settings.videoWorkers=next}
      for(const key of ['imageTimeout','videoTimeout']) if(data[key]!==undefined) settings[key]=Math.max(1,Math.min(240,Number(data[key])||DEFAULT_SETTINGS[key]));
      for(const key of ['allowedDomainsEnabled','allowedDomains','promptSeparator','autoReservePercent']) if(data[key]!==undefined) settings[key]=key==='autoReservePercent'?Math.max(0,Math.min(100,Number(data[key])||0)):data[key];
      if(data.imageAccountId!==undefined){const id=String(data.imageAccountId||'');if(id&&!accounts.some(a=>a.id===id))return respond(res,400,{error:'Không tìm thấy tài khoản dành cho ảnh.'});settings.imageAccountId=id;}
      if(data.videoAccountMode!==undefined){const mode=String(data.videoAccountMode);if(!['all','exclude-image-account'].includes(mode))return respond(res,400,{error:'Chế độ chọn tài khoản video không hợp lệ.'});settings.videoAccountMode=mode;}
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
      if(ids.length>20000)return respond(res,400,{error:'Chỉ xóa tối đa 20.000 tác vụ mỗi lần.'});
      const activeStatuses=new Set(['Đang tạo trên Muse','Đang gửi lên Muse']);
      const byId=new Map();for(const batch of batches.values())for(const job of batch.jobs)byId.set(job.id,{batch,job});
      const selected=ids.map(id=>byId.get(id)).filter(Boolean);
      const isActive=item=>runningBatches.has(item.batch.id)||scheduledBatches.has(item.batch.id)||activeStatuses.has(item.job.status);
      const deletable=selected.filter(item=>!isActive(item)),deletableIds=new Set(deletable.map(item=>item.job.id)),skipped=ids.filter(id=>!byId.has(id)||isActive(byId.get(id)));
      // Validate every result path before changing history or removing any files.
      const files=new Set();
      for(const {job} of deletable)if(job.outputPath){const file=outputFileForDeletion(job.outputPath);if(file)files.add(file)}
      const remainingFiles=new Set();for(const batch of batches.values())for(const job of batch.jobs)if(!deletableIds.has(job.id)&&job.outputPath)remainingFiles.add(path.resolve(job.outputPath));
      for(const file of files)if(remainingFiles.has(path.resolve(file)))files.delete(file);
      for(const file of files)fs.unlinkSync(file);
      const deleted=[];
      for(const {batch,job} of deletable){const index=batch.jobs.findIndex(item=>item.id===job.id);if(index>=0){batch.jobs.splice(index,1);deleted.push(job.id);if(!batch.jobs.length)batches.delete(batch.id)}}
      persistHistory();return respond(res,200,{ok:true,deleted,skipped,removedFiles:files.size});
    } catch(e) { return respond(res,500,{error:e.message}); }
  }
  if(req.method==='DELETE' && url.pathname.startsWith('/api/jobs/')) { try { const id=decodeURIComponent(url.pathname.slice('/api/jobs/'.length));let owner=null,index=-1;for(const batch of batches.values()){index=batch.jobs.findIndex(job=>job.id===id);if(index>=0){owner=batch;break}}if(!owner)return respond(res,404,{error:'Không tìm thấy tác vụ.'});const job=owner.jobs[index];if(job.outputPath){const outputRoot=outputRootDir(),target=path.resolve(job.outputPath),relative=path.relative(outputRoot,target);if(relative.startsWith('..')||path.isAbsolute(relative))return respond(res,400,{error:'File kết quả nằm ngoài thư mục lưu.'});if(fs.existsSync(target))fs.unlinkSync(target)}owner.jobs.splice(index,1);if(!owner.jobs.length)batches.delete(owner.id);persistHistory();return respond(res,200,{ok:true}); } catch(e) { return respond(res,500,{error:e.message}); } }
  if(req.method==='GET' && url.pathname==='/api/muse/status') return respond(res,200,museStatus());
  if(req.method==='POST' && url.pathname==='/api/muse/stop-active') {
    try {
      const data=await bodyJson(req),id=data.accountId||museAccountId||'default';
      if(runningBatches.size&&id!==museAccountId)return respond(res,409,{error:'Tài khoản hiện tại còn tác vụ K Studio đang chạy. Đợi xong rồi chuyển phiên.'});
      let status=museStatus();
      if(status.state!=='ready'||status.accountId!==id)status=await connectMuse(id,true);
      if(status.state!=='ready')return respond(res,409,{error:'Tài khoản Muse chưa sẵn sàng.'});
      if(!/^https?:\/\/(www\.)?muse\.ai\/?(?:[?#].*)?$/i.test(musePage.url()))await musePage.goto('https://muse.ai/',{waitUntil:'domcontentloaded'});
      await musePage.waitForTimeout(1200);
      let stopped=0;
      for(let pass=0;pass<5;pass++){
        const clicked=await musePage.evaluate(()=>{
          const visible=element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return style.visibility!=='hidden'&&style.display!=='none'&&box.width>0&&box.height>0};
          const buttons=Array.from(document.querySelectorAll('button,[role="button"]')).filter(element=>{
            if(!visible(element))return false;
            const label=[element.getAttribute('aria-label'),element.getAttribute('title'),element.textContent].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
            return /^(stop|stop generating|dừng|dừng tạo)$/i.test(label);
          });
          for(const button of buttons)button.click();
          return buttons.length;
        });
        stopped+=clicked;
        if(!clicked)break;
        await musePage.waitForTimeout(800);
      }
      return respond(res,200,{ok:true,stopped,accountId:id});
    } catch(e) { return respond(res,500,{error:e.message}); }
  }
  if(req.method==='POST' && url.pathname==='/api/muse/connect') {
    if(sideChatCleanup.status==='running')return respond(res,409,{error:'Đang dọn chat phụ; đợi xong rồi kết nối Muse.'});
    try { const data=await bodyJson(req),id=data.accountId||'default';if(runningBatches.size&&id!==museAccountId)return respond(res,409,{error:'Tài khoản hiện tại còn tác vụ đang chạy. Đợi xong rồi chuyển phiên.'});const result=await connectMuse(id,Boolean(data.hidden));if(result.state==='ready'){syncAutomaticWorkerCapacity();resumePausedBatches()}return respond(res,200,result); }
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
      const inferredType=types.find(type=>type==='Ảnh'||type==='Video')||'Ảnh';
      const workers=Math.max(1,Math.min(maximumWorkersForAccounts(accountsForType(inferredType)),Number(data.workers)||(settings.workerCountMode==='auto'?workerCapacityForType(inferredType):(inferredType==='Video'?settings.videoWorkers:settings.imageWorkers))));
      const accountId=accounts.some(a=>a.id===data.accountId&&a.enabled)?data.accountId:(accounts.find(a=>a.primary&&a.enabled)||accounts.find(a=>a.enabled))?.id;
      if(!accountId)return respond(res,400,{error:'Không có tài khoản Muse đang bật.'});
      const batch={id:crypto.randomUUID(),status:'Đang chờ',workers,accountId,strictAccount:Boolean(data.strictAccount),createdAt:new Date().toISOString(),jobs:valid.map(item=>{const id=crypto.randomUUID(),type=detect(item.prompt),job={id,prompt:item.prompt,type,status:'Trong hàng đợi'};if(item.referenceImage){const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}[item.referenceImage.mimeType];fs.mkdirSync(REFERENCE_DIR,{recursive:true});job.referenceImagePath=path.join(REFERENCE_DIR,id+ext);job.referenceName=path.basename(String(item.referenceImage.name||'anh-tham-chieu'+ext)).slice(0,180);fs.writeFileSync(job.referenceImagePath,Buffer.from(String(item.referenceImage.data).split(',')[1],'base64'))}return job})};
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
    const content=fs.readFileSync(target);
    return res.end(requested==='dashboard.html'?Buffer.from(content.toString('utf8').replace('__KSTUDIO_VERSION__',APP_VERSION)):content);
  }
  respond(res,405,{error:'Method not allowed'});
});
server.listen(PORT,'127.0.0.1',()=>{
  console.log(`Muse Batch: http://127.0.0.1:${PORT}`);
  console.log(`Tài khoản: ${accounts.length} từ ${ACCOUNTS_FILE}`);
  for(const batch of batches.values()){
    if(!['Đang chạy trên Muse','Đang chờ','Tạm dừng: ngưỡng hạn mức','Tạm dừng: hết hạn mức','Tạm dừng: cần đăng nhập'].includes(batch.status))continue;
    for(const job of batch.jobs)if(['Đang gửi lên Muse','Đang tạo trên Muse'].includes(job.status)){
      job.status='Lỗi';job.error='Máy chủ đã khởi động lại khi tác vụ có thể đã được gửi. Kiểm tra Muse trước khi tạo lại để tránh video trùng.';
    }
    if(batch.jobs.some(j=>j.status==='Trong hàng đợi'))queueBatch(batch);
    else batch.status=batch.jobs.some(j=>j.status==='Lỗi')?'Hoàn tất, có lỗi':'Hoàn tất';
  }
  persistHistory();
});
localApiControl=startLocalApi({dataRoot:DATA_ROOT,outputRootDir,referenceDir:REFERENCE_DIR,batches,accounts,queueBatch,persistHistory,runningBatches,accountReady:account=>activeAccountJobs.has(account.id)||(museState==='ready'&&museAccountId===account.id&&museContextIsAlive())||accountHasSavedSession(account),defaultQuotaThreshold:()=>null,defaultWorkerCount:type=>settings.workerCountMode==='auto'?workerCapacityForType(type):(type==='Video'?settings.videoWorkers:settings.imageWorkers),maxWorkerCount:workerCapacityForType});
setTimeout(()=>{
  if(scheduledBatches.size||runningBatches.size)return;
  const account=accounts.find(a=>a.primary&&a.enabled)||accounts.find(a=>a.enabled);
  if(account)connectMuse(account.id,true).catch(error=>{museState='error';console.error('Muse startup:',error.message)});
},1500).unref();
setInterval(()=>watchMuseLogin().catch(error=>console.error('Muse login watch:',error.message)),5000).unref();
process.on('SIGINT', async () => {
  await stopMuseWindowWatcher();
  if (museContext) await museContext.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

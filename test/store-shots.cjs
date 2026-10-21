/* Render the actual extension UI with synthetic data in a fresh, offline browser.
 * Does not read a user Chrome profile, cookies, downloads, or live ChatGPT data.
 * PLAYWRIGHT_MODULE=/path/to/playwright node test/store-shots.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'store/v1.6');
fs.mkdirSync(out, {recursive:true});
const prompts = [
  'Create a collection of minimalist landscape posters in warm earth tones.',
  'Make a second series with a cooler palette and softer shapes.',
  'Write a short title and description for each poster.',
  'Suggest a cohesive layout for the full collection.'
];
function art(i) {
 const palettes=[['#f5e7d4','#e79e64','#8a4b34','#c66b4d'],['#e1e9df','#eac97b','#436d67','#82a399'],['#f2d5c7','#f3b749','#6d5a79','#b18593'],['#dce4eb','#e8c084','#2f5970','#7a9aa8']];
 const [bg,sun,mountain,front]=palettes[i%4];
 return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700" viewBox="0 0 600 700"><rect width="600" height="700" fill="${bg}"/><circle cx="${220+i%3*65}" cy="230" r="105" fill="${sun}"/><path d="M0 490L160 290L310 440L440 310L600 490V700H0Z" fill="${mountain}"/><path d="M0 530Q170 430 340 555T600 510V700H0Z" fill="${front}"/><path d="M0 620Q240 530 600 625" fill="none" stroke="${bg}" stroke-width="3" opacity=".7"/></svg>`;
}
const items=Array.from({length:12},(_,i)=>({id:'demo-'+i,created_at:1792497600-i*900,url:'/demo/'+i+'.svg',width:600,height:700,prompt:'Synthetic landscape poster '+(i+1)}));
function html(title,sub,wide=false){return `<!doctype html><html class="dark"><meta charset="utf-8"><title>Prompt Stacker demo</title><style>
*{box-sizing:border-box}html,body{margin:0;width:1280px;height:800px;overflow:hidden;background:#111d1c;color:#edf5ef;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif}
body{background:radial-gradient(ellipse at 85% 45%,#21443b 0,transparent 58%),#111d1c}
.copy{position:absolute;left:76px;top:${wide?'30':'165'}px;width:${wide?'1120':'570'}px}
.brand{font-size:17px;letter-spacing:.04em;color:#b2c7ba;margin-bottom:${wide?'14':'34'}px;display:flex;gap:12px;align-items:center}.brand img{width:28px;height:28px}
h1{margin:0 0 24px;font-size:${wide?'38':'67'}px;line-height:1.06;letter-spacing:-.045em;font-weight:650}p{font-size:${wide?'19':'23'}px;line-height:1.5;color:#b5cbbd;margin:0;max-width:510px}.foot{position:absolute;left:76px;bottom:35px;font-size:13px;color:#8da99a;letter-spacing:.025em}
#cps-panel{right:86px!important;top:95px!important;left:auto!important;max-height:650px!important;box-shadow:0 25px 80px #0008!important;--cps-accent:#25b78a}
</style><body><section class="copy"><div class="brand"><img src="/icon128.png">PROMPT STACKER · 1.6</div><h1>${title}</h1><p>${sub}</p></section><div class="foot">${wide?'Synthetic demo artwork · Actual Image Grabber interface':'ChatGPT · Claude · Gemini · DeepSeek'}</div></body></html>`;}
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.QA_CHROME});
 const ctx=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,colorScheme:'dark',locale:'en-US',timezoneId:'UTC'});
 let blocked=0;
 await ctx.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin!=='https://chatgpt.com'){blocked++;return route.abort();}
  if(u.pathname==='/icon128.png')return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(repo,'icon128.png'))});
  if(u.pathname==='/api/auth/session')return route.fulfill({json:{accessToken:'synthetic-demo-only'}});
  if(u.pathname.includes('/backend-api/my/recent/image_gen'))return route.fulfill({json:{items,cursor:null}});
  if(u.pathname.startsWith('/demo/'))return route.fulfill({contentType:'image/svg+xml',body:art(Number(u.pathname.match(/\d+/)[0]))});
  return route.fulfill({contentType:'text/html',body:'<!doctype html><html></html>'});
 });
 async function page(title,sub,wide=false,history=false){
  const p=await ctx.newPage(); await p.goto('https://chatgpt.com/demo');
  await p.setContent(html(title,sub,wide));
  await p.evaluate(({prompts,history})=>{
   const data={cps_queue:prompts,cps_chains:[{id:1,name:'Landscape poster collection',prompts},{id:2,name:'Product launch copy',prompts:['Outline the launch story.','Draft three headlines.','Write the final announcement.']}],cps_settings:{themeMode:'dark',delay:3,repeat:1},cps_onboarding_dismissed:true};
   if(history)data['ctig.history']={at:1792495800,runAt:'2026-10-20T12:00:00Z',count:2,avgBytes:2200000,ids:['demo-3','demo-2'],failed:[]};
   const listeners=[];
   const area={get:(keys,cb)=>{let result={};for(const k of typeof keys==='string'?[keys]:keys||Object.keys(data)){if(k in data)result[k]=data[k];}if(cb){cb(result);return;}return Promise.resolve(result);},set:(values,cb)=>{Object.assign(data,values);if(cb)cb();return Promise.resolve();},remove:(key)=>{delete data[key];return Promise.resolve();}};
   window.chrome={runtime:{getURL:p=>'/'+p,lastError:null},storage:{local:area,sync:area,onChanged:{addListener:fn=>listeners.push(fn)}}};
  },{prompts,history});
  await p.addStyleTag({path:path.join(repo,'panel.css')});
  for(const name of ['busy-lock.js','content.js','images-tab.js','zip-lib.js','grabber.js','library.js','thread.js'])await p.addScriptTag({path:path.join(repo,name)});
  await p.locator('#cps-panel .cps-header').click();
  return p;
 }
 const records=[];
 async function save(p,name){
  await p.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  await p.screenshot({path:path.join(out,name),animations:'disabled'});
  records.push({file:name,width:1280,height:800,source:'actual extension UI, synthetic fixture; no personal profile'});await p.close();
 }
 let p=await page('A whole workflow.<br>One prompt queue.','Line up your ideas. Each prompt sends when the previous reply finishes.');
 assert.equal(await p.locator('.cps-item').count(),4);await save(p,'01-queue.png');
 p=await page('Keep your best<br>prompt chains.','Save a sequence once. Bring it back whenever inspiration strikes.');
 await p.locator('[data-tab="library"]').click();assert.equal(await p.locator('.cps-chain').count(),2);await save(p,'02-chains.png');
 p=await page('Your ChatGPT images.<br>Ready to save.','Pick from your image library or grab the generated images in a conversation.');
 await p.locator('[data-tab="images"]').click();assert.equal(await p.locator('#cps-img-library').isEnabled(),true);await save(p,'03-images.png');
 async function picker(p){
  await p.locator('[data-tab="images"]').click();await p.locator('#cps-img-library').click();await p.locator('.cell').nth(11).waitFor();
  await p.evaluate(()=>{const style=document.createElement('style');style.textContent='.backdrop{top:167px;bottom:66px;background:transparent}.panel{height:100%;width:1160px;box-shadow:0 14px 50px #0006}.grid{--cell:170px}';document.querySelector('#chatgpt-thread-image-grabber').shadowRoot.append(style);});
  await p.locator('.cell img').evaluateAll(async imgs=>Promise.all(imgs.map(img=>img.decode())));
 }
 p=await page('Pick your favorites. Download a ZIP.','',true);await picker(p);
 for(const i of [0,1,4])await p.locator('.cell').nth(i).click();
 assert.equal(await p.locator('.cell.on').count(),3);await save(p,'04-picker.png');
 p=await page('See what is new. Keep track of what is saved.','',true,true);await picker(p);await p.locator('[data-act="new"]').click();
 await p.waitForFunction(()=>document.querySelector('#chatgpt-thread-image-grabber').shadowRoot.querySelector('.status').textContent.startsWith('2 new since'));
 assert.equal(await p.locator('.cell.on').count(),2);assert.equal(await p.locator('.cell.had').count(),2);await save(p,'05-select-new.png');
 p=await ctx.newPage();await p.setViewportSize({width:440,height:280});await p.setContent(`<html><body style="margin:0;width:440px;height:280px;background:#12352b;display:flex;align-items:center;justify-content:center"><img width="160" height="160" src="data:image/png;base64,${fs.readFileSync(path.join(repo,'icon128.png')).toString('base64')}"></body></html>`);await p.locator('img').evaluate(i=>i.decode());await p.screenshot({path:path.join(out,'promo-440x280.png')});
 assert.equal(blocked,0);fs.writeFileSync(path.join(out,'provenance.json'),JSON.stringify({screenshots:records,artwork:'Original geometric SVG fixtures authored in this script; no downloaded artwork or real account data.',network:'All requests intercepted locally; zero external destinations.',promo:{width:440,height:280}},null,2));
 await browser.close();console.log('Rendered five 1280x800 screenshots and 440x280 promo; synthetic data only.');
})().catch(e=>{console.error(e);process.exitCode=1;});

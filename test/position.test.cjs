/* Regression tests for issue #1. Execute the real position/drag functions in a
   small DOM fixture; no dependencies and no access to real extension storage. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');

function fixture(hostname = 'chatgpt.com', initialStorage = {}) {
  const storage = structuredClone(initialStorage);
  const documentEvents = {};
  const handleEvents = {};
  const classes = new Set(['cps-collapsed']);
  const controls = new Map();
  const panel = {
    isConnected: true,
    style: {},
    get offsetLeft(){return this.getBoundingClientRect().left;},
    get offsetTop(){return this.getBoundingClientRect().top;},
    get offsetWidth(){return this.getBoundingClientRect().width;},
    get offsetHeight(){return this.getBoundingClientRect().height;},
    classList: {
      contains: name => classes.has(name),
      toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); },
    },
    querySelector(selector) {
      if (!controls.has(selector)) controls.set(selector, {});
      return controls.get(selector);
    },
    getBoundingClientRect() {
      const collapsed = classes.has('cps-collapsed');
      const width = collapsed ? 222 : 322;
      const height = collapsed ? 46 : 600;
      const left = this.style.left ? parseFloat(this.style.left) : context.window.innerWidth - width - 12;
      const top = this.style.top ? parseFloat(this.style.top) : 80;
      return {left, top, width, height, right:left + width, bottom:top + height};
    },
  };
  const context = vm.createContext({
    document:{body:null,addEventListener(type,fn){documentEvents[type]=fn;}},
    window:{innerWidth:1000,innerHeight:800,addEventListener(){}},
    location:{hostname}, requestAnimationFrame:fn=>fn(),
    chrome:{runtime:{},storage:{local:{set(data,cb){Object.assign(storage,structuredClone(data));cb?.();}}}},
  });
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
    globalThis.positions = {
      bind(el){panel=el},toggle:toggleCollapse,restore:restorePanelPositions,
      apply:applyPanelPosition,save:rememberPanelPosition,drag:makeDraggable,
    };
  })();`), context);
  context.positions.bind(panel);
  const handle = {addEventListener(type,fn){handleEvents[type]=fn;}};
  context.positions.drag(panel,handle);
  const event = (x,y,icon=false) => ({clientX:x,clientY:y,target:{closest:()=>icon},preventDefault(){}});
  return {
    panel, storage, context, api:context.positions,
    at:()=>({left:panel.getBoundingClientRect().left,top:panel.getBoundingClientRect().top}),
    moveTo(left,top) {
      const r = panel.getBoundingClientRect();
      handleEvents.mousedown(event(r.left+10,r.top+10));
      documentEvents.mousemove(event(left+10,top+10));
      documentEvents.mouseup(event(left+10,top+10));
    },
    clickHeader(){handleEvents.mousedown(event(50,50));documentEvents.mouseup(event(50,50));},
  };
}

let passed=0;
function test(name,fn){fn();passed++;console.log('  ✓ '+name);}
console.log('panel position / issue #1');

test('expanding near the right edge does not change the returning pill position',()=>{
  const f=fixture();const original=f.at();
  f.api.toggle();assert.equal(f.at().left,666);
  f.api.toggle();assert.deepEqual(f.at(),original);
});
test('compact and expanded dragging remember separate positions',()=>{
  const f=fixture();f.moveTo(650,650);f.api.toggle();f.moveTo(140,100);
  f.api.toggle();assert.deepEqual(f.at(),{left:650,top:650});
  f.api.toggle();assert.deepEqual(f.at(),{left:140,top:100});
});
test('positions survive page refresh and startup remains compact',()=>{
  const first=fixture();first.moveTo(650,650);first.api.toggle();first.moveTo(140,100);
  const fresh=fixture('chatgpt.com',first.storage);fresh.api.restore(fresh.storage);
  assert.ok(fresh.panel.classList.contains('cps-collapsed'));
  assert.deepEqual(fresh.at(),{left:650,top:650});
  fresh.api.toggle();assert.deepEqual(fresh.at(),{left:140,top:100});
});
test('restored positions are kept inside a smaller viewport',()=>{
  const f=fixture();f.context.window.innerWidth=360;f.context.window.innerHeight=300;
  f.api.restore({cps_position_chatgpt_collapsed:{left:900,top:700}});
  assert.deepEqual(f.at(),{left:130,top:246});
});
test('temporary viewport clamping does not lose the preferred position',()=>{
  const f=fixture();f.moveTo(650,650);f.context.window.innerWidth=360;f.context.window.innerHeight=300;
  f.api.apply();f.context.window.innerWidth=1000;f.context.window.innerHeight=800;f.api.apply();
  assert.deepEqual(f.at(),{left:650,top:650});
});
test('platforms do not overwrite each other’s position keys',()=>{
  for(const [host,name] of [['chatgpt.com','chatgpt'],['claude.ai','claude'],['gemini.google.com','gemini'],['chat.deepseek.com','deepseek']]){
    const f=fixture(host);f.moveTo(100,100);
    assert.deepEqual(Object.keys(f.storage),['cps_position_'+name+'_collapsed']);
  }
});
test('invalid saved coordinates are ignored',()=>{
  for(const position of [null,{}, {left:'100',top:50},{left:NaN,top:50},{left:Infinity,top:50},{left:-10,top:50}]){
    const f=fixture();f.api.restore({cps_position_chatgpt_collapsed:position});
    assert.deepEqual(f.at(),{left:766,top:80});
  }
});
test('late storage restore does not overwrite a position already dragged',()=>{
  const f=fixture();f.moveTo(100,100);f.api.restore({cps_position_chatgpt_collapsed:{left:500,top:500}});
  assert.deepEqual(f.at(),{left:100,top:100});
});
test('header click toggles without overwriting the other mode',()=>{
  const f=fixture();f.moveTo(650,650);f.clickHeader();f.moveTo(140,100);f.clickHeader();
  assert.deepEqual(f.at(),{left:650,top:650});
});
test('storage failure does not break in-memory position restoration',()=>{
  const f=fixture();f.context.chrome.storage.local.set=()=>{throw Error('unavailable')};
  f.moveTo(650,650);f.api.toggle();f.moveTo(140,100);f.api.toggle();
  assert.deepEqual(f.at(),{left:650,top:650});
});
test('restoring ignores transformed bounds during the entrance animation',()=>{
  const f=fixture();
  const layout=f.panel.getBoundingClientRect.bind(f.panel);
  for(const [key,field] of [['offsetLeft','left'],['offsetTop','top'],['offsetWidth','width'],['offsetHeight','height']])
    Object.defineProperty(f.panel,key,{get:()=>layout()[field]});
  f.panel.getBoundingClientRect=()=>{const r=layout();return {...r,left:r.left+3,top:r.top-6,width:r.width*.985,height:r.height*.985};};
  f.api.restore({cps_position_chatgpt_collapsed:{left:100,top:80}});
  assert.equal(f.panel.style.left,'100px');assert.equal(f.panel.style.top,'80px');
  f.api.apply();assert.equal(f.panel.style.top,'80px');
});
console.log(`\n${passed} position tests passed.`);

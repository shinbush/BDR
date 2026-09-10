const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../telegram.js'),'utf8');
function launch(version='8.0',initData='signed-test-data',throws=false) {
  const calls={fullscreen:0,expand:0},events={},styles={},classes={};
  const webApp={initData,isFullscreen:false,initDataUnsafe:{user:{id:123,first_name:'Test'}},safeAreaInset:{top:47,bottom:34},contentSafeAreaInset:{top:44},ready(){},expand(){calls.expand++},requestFullscreen(){calls.fullscreen++;if(throws)throw Error('unsupported')},isVersionAtLeast(){return Number(version)>=8},onEvent(name,callback){events[name]=callback}};
  const root={style:{setProperty(k,v){styles[k]=v}},classList:{toggle(k,v){classes[k]=v}}};
  const context={window:{Telegram:{WebApp:webApp}},document:{documentElement:root,getElementById(){return {textContent:''}}}};
  vm.runInNewContext(source,context);return {calls,events,styles,classes,webApp,context};
}
test('Telegram 8+ requests fullscreen at launch and respects both safe areas',()=>{
  const result=launch();assert.equal(result.calls.fullscreen,1);assert.equal(result.styles['--app-safe-top'],'91px');assert.equal(result.styles['--app-safe-bottom'],'34px');
  result.webApp.isFullscreen=true;result.events.fullscreenChanged();assert.equal(result.classes['tg-fullscreen'],true);
  assert.equal(result.context.window.TG.storageKey,'kopilka-data-123');
});
test('older Telegram and ordinary browsers never request fullscreen',()=>{
  assert.equal(launch('7.10').calls.fullscreen,0);assert.equal(launch('8.0','').calls.fullscreen,0);
});
test('fullscreen rejection and unsupported platforms retain expanded working app',()=>{
  const result=launch();result.events.fullscreenFailed();assert.equal(result.calls.expand,2);
  assert.equal(launch('8.0','test',true).calls.expand,2);
});

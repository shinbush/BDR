const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const app=read('app.js'),html=read('index.html'),css=read('styles.css');
const context=vm.createContext({money:n=>`${n} ₽`,escapeHtml:value=>String(value)});
vm.runInContext(read('planning.js'),context);
vm.runInContext(app.slice(app.indexOf('function budgetCardHtml('),app.indexOf('function render(){')),context);
test('overspent red-category budget becomes normal immediately after raising its limit',()=>{
  const category={id:'food',emoji:'🛒',name:'Food',color:'#ff0000'},plan={budgets:{food:1000},spent:{food:1500}};
  let card=context.budgetCardHtml(category,plan);
  assert.match(card,/class="budget-item over"/);assert.match(card,/Перерасход/);assert.match(card,/width:100%/);
  plan.budgets.food=3000;card=context.budgetCardHtml(category,plan);
  assert.match(card,/class="budget-item"/);assert.doesNotMatch(card,/Перерасход|#ff0000|background:/);
  assert.match(card,/50% использовано/);assert.match(card,/width:50%/);
  assert.ok(css.includes('.budget-item:not(.over)>.budget-bar>span{background:#6756d9}'));
  assert.ok(css.includes('.budget-item.over>.budget-bar>span{background:var(--red)}'));
});
test('zero limit, exact limit and lowered limit have current progress states',()=>{
  assert.equal(context.planningBudgetProgress(0,0).over,false);
  assert.equal(context.planningBudgetProgress(0,200).width,100);
  assert.equal(context.planningBudgetProgress(200,200).over,false);
  assert.equal(context.planningBudgetProgress(199,200).over,true);
});
test('month and salary plans recalculate independently after limit changes',()=>{
  const tx=[{type:'expense',category:'food',date:'2026-09-03',amount:600},{type:'expense',category:'food',date:'2026-09-12',amount:900}];
  const now=new Date(2026,8,12),monthly=context.planningPeriod('month','',now),salary=context.planningPeriod('salary','2026-09-05',now);
  for(const period of [monthly,salary]) {
    const spent=context.planningSpent(tx,period).food;
    assert.equal(context.planningBudgetProgress(500,spent).over,true);
    assert.equal(context.planningBudgetProgress(2000,spent).over,false);
  }
  assert.equal(context.planningSpent(tx,monthly).food,1500);assert.equal(context.planningSpent(tx,salary).food,900);
});
test('payments are one nested section in plan, legacy navigation opens plan and scrolls to it',()=>{
  const plan=html.slice(html.indexOf('<section id="plan"'),html.indexOf('<section id="goals"'));
  assert.ok(plan.includes('id="payments" class="plan-payments-section"'));
  assert.equal((html.match(/id="plannedPaymentsList"/g)||[]).length,1);
  assert.doesNotMatch(html, /id="payments" class="screen"/);
  const classes={},nodes={};
  for(const id of ['home','plan','stats'])nodes[id]={id,classList:{toggle(_,active){classes[id]=active}}};
  let scrolled=false;
  const ctx=vm.createContext({document:{querySelectorAll:selector=>selector==='.screen'?Object.values(nodes):[]},window:{scrollTo(){}},requestAnimationFrame:callback=>callback(),$:selector=>selector==='#payments'?{scrollIntoView(){scrolled=true}}:{},renderAnalytics(){},syncBalanceHeight(){}});
  vm.runInContext(app.slice(app.indexOf('function showScreen('),app.indexOf('function closeModal(')),ctx);
  ctx.showScreen('payments');assert.equal(classes.plan,true);assert.equal(classes.home,false);assert.equal(scrolled,true);
});

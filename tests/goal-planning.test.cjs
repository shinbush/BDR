const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root,'goal-planning.js'),'utf8'),context);
const now=new Date(2026,8,6,12);
const goal={id:'mac',target:150000,current:87000,date:'2026-12-31',monthlyEnabled:true,monthlyAmount:15750,monthlyStartMonth:'2026-09'};
const detail=(item=goal,transactions=[],month='2026-09')=>context.goalPlanDetails(item,transactions,now,month);
const deposit=(amount,date='2026-09-10')=>({goalId:'mac',type:'goal_deposit',amount,date});

test('63,000 remaining, four calendar months, 15,750 per month',()=>{
  const result=detail();assert.equal(result.remaining,63000);assert.equal(result.months,4);assert.equal(result.recommended,15750);assert.equal(result.reserve,15750);
});
test('legacy goals are opt-in; planning never mutates the ledger',()=>{
  const transactions=[deposit(1000)];const before=JSON.stringify(transactions);
  assert.equal(detail({...goal,monthlyEnabled:undefined},transactions).reserve,0);
  detail(goal,transactions);assert.equal(JSON.stringify(transactions),before);
});
test('manual contributions release the reserve without double counting',()=>{
  const transactions=[deposit(5000)];const result=detail({...goal,current:92000},transactions);
  assert.equal(result.reserve,10750);assert.equal(result.recommended,15750);
  assert.equal(82000-15750,(82000-5000)-result.reserve);
  assert.equal(detail({...goal,current:102750},[deposit(15750)]).reserve,0);
});
test('withdrawals and deleted contributions restore the monthly reserve',()=>{
  const transactions=[deposit(5000),{...deposit(2000),type:'goal_withdrawal'}];
  assert.equal(detail({...goal,current:90000},transactions).reserve,12750);
  assert.equal(detail(goal,[]).reserve,15750);
});
test('new initial savings are not this month’s regular contribution',()=>{
  assert.equal(detail(goal,[{...deposit(87000),initialFunding:true}]).reserve,15750);
});
test('caps at remaining amount and stops on completion or disabled planning',()=>{
  assert.equal(detail({...goal,current:149000}).reserve,1000);
  assert.equal(detail({...goal,current:150000}).reserve,0);
  assert.equal(detail({...goal,monthlyEnabled:false}).reserve,0);
});
test('monthly rollover resets reserve; no retroactive reserve before activation',()=>{
  assert.equal(detail(goal,[deposit(15750)],'2026-10').reserve,15750);
  assert.equal(detail(goal,[],'2026-08').reserve,0);
});
test('no deadline allows a custom monthly amount; overdue dates remain explicit',()=>{
  assert.equal(detail({...goal,date:''}).recommended,0);assert.equal(detail({...goal,date:''}).reserve,15750);
  assert.equal(detail({...goal,date:'2026-08-31'}).overdue,true);
  assert.equal(detail({...goal,date:'2026-09-06'}).months,1);
});
test('combined reserve respects goal identity and deletion',()=>{
  const other={...goal,id:'trip',monthlyAmount:2000};
  assert.equal(context.goalMonthlyReserve([goal,other],[deposit(5000)],'2026-09',now),12750);
  assert.equal(context.goalMonthlyReserve([other],[deposit(5000)],'2026-09',now),2000);
});
test('safe spending deducts future goal reserve once alongside budgets and reminders',()=>{
  const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const functions=app.slice(app.indexOf('function currentMonthPlanForSafeSpending()'),app.indexOf('function renderSafeSpending()'));
  context.state={goals:[{...goal,monthlyStartMonth:'2000-01'}],transactions:[],plans:{current:{budgets:{food:10000},spent:{food:2000}}}};
  context.monthKey=()=> 'current';context.availableNow=()=>82000;context.goalNet=()=>87000;
  vm.runInContext(functions,context);
  const result=context.safeSpendingDetails({total:3000,byCategory:{food:3000}});
  assert.equal(result.budgetExtra,5000);assert.equal(result.futureGoals,15750);assert.equal(result.free,58250);
});

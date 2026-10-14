import { test, expect } from '@playwright/test';

const address = '0x'+'ab'.repeat(20);
const init = async (page, html, site) => {
  await page.goto('/tests/fixtures/page.html'); await page.setContent(html); await page.addStyleTag({url:'/extension/page.css'});
  await page.evaluate(async ({site,address})=>{
    const {createPageController}=await import('/extension/page.js');
    window.siteURL=new URL(site);
    window.state={connectionKey:'http://127.0.0.1:8712',connectionName:'Local',selectionGeneration:1,stateRevision:1,records:[{address,scope:'global',labels:['Global name'],version:'one'}]};
    window.drafts=[];
    window.controller=await createPageController({state:window.state,url:()=>window.siteURL,save:async draft=>{window.drafts.push(draft);return {state:window.state};}});
  },{site,address});
};

test('current Safe header supports composed text and canonical route; unknown networks use global',async({page})=>{
  await init(page,`<header><div><span data-testid="safe-selector-trigger-name">0xabab…abab</span><span data-testid="safe-selector-trigger-address"><b>0xabab</b><span>${'ab'.repeat(16)}</span><b>abab</b></span><a data-testid="safe-item-explorer-link" href="https://etherscan.io/address/${address}">↗</a><button>Copy</button></div></header><div data-testid="sidebar-container"></div>`,`https://app.safe.global/home?safe=unknown:${address}`);
  await expect(page.locator('[data-testid="safe-selector-trigger-address"]')).toHaveAttribute('data-0xlabel-label','Global name');
  await page.locator('[data-testid="safe-selector-trigger-address"]').hover();
  await page.getByRole('button',{name:'Edit wallet labels',exact:true}).nth(1).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

test('contradictory full sources pause instead of mislabeling; Retry cannot override them',async({page})=>{
  await init(page,`<header></header><main><a id="wallet" data-full-address="${address}" href="/address/0x${'cd'.repeat(20)}">${address}</a></main>`,'https://etherscan.io/accounts');
  expect(await page.evaluate(()=>window.controller.health.status)).toBe('stale');
  await expect(page.locator('[data-0xlabel-label],[data-0xlabel-address]')).toHaveCount(0);
  await page.evaluate(()=>window.controller.retry());
  expect(await page.evaluate(()=>window.controller.health.status)).toBe('stale');
});

test('page state revision prevents delayed snapshots undoing a confirmed label',async({page})=>{
  await init(page,`<p id="wallet">${address}</p>`,'https://plain.example');
  await page.evaluate(()=>{
    window.controller.updateState({...window.state,stateRevision:3,records:[{...window.state.records[0],labels:['Newest']}]});
    window.controller.updateState({...window.state,stateRevision:2});
    const {stateRevision, ...incomplete} = window.state;
    window.controller.updateState(incomplete);
  });
  await expect(page.locator('#wallet')).toHaveAttribute('data-0xlabel-label','Newest');
});

test('new inline labels use global scope; Enter during composition does not save',async({page})=>{
  await init(page,`<header></header><main><a data-highlight-target="${address}" href="/address/${address}">${address}</a></main>`,'https://etherscan.io/accounts');
  await page.evaluate(() => {
    window.state = { ...window.state, stateRevision: 2, records: [] };
    window.controller.updateState(window.state);
  });
  await page.locator('main a').hover(); await page.getByRole('button',{name:'Edit wallet labels',exact:true}).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'Label 1'})).toHaveValue('');
  await expect(page.getByRole('button',{name:'Close editor'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^Show (my label|website original)$/})).toHaveCount(0);
  await page.getByRole('textbox',{name:'Label 1'}).dispatchEvent('keydown',{key:'Enter',isComposing:true});
  expect(await page.evaluate(()=>window.drafts.length)).toBe(0);
  await page.getByRole('textbox',{name:'Label 1'}).fill('Shared name');
  await expect(page.getByRole('button',{name:/^Show (my label|website original)$/})).toHaveCount(0);
  await page.getByRole('textbox',{name:'Label 1'}).press('Enter');
  expect(await page.evaluate(()=>window.drafts[0])).toMatchObject({address,scope:'global',version:null,labels:['Shared name']});
});

test('waiting becomes ready with a complete scan, even when an existing address did not change',async({page})=>{
  await init(page,`<main><span id="wallet">${address}</span><div id="loading" role="progressbar"></div></main>`,'https://app.safe.global/home');
  expect(await page.evaluate(()=>window.controller.health.status)).toBe('waiting');
  await expect(page.locator('#wallet')).not.toHaveAttribute('data-0xlabel-label');
  await page.locator('#loading').evaluate(element=>element.remove());
  await expect(page.locator('#wallet')).toHaveAttribute('data-0xlabel-label','Global name');
});

test('a growing editor stays inside the viewport',async({page})=>{
  await init(page,`<p style="margin-top:610px"><a href="#wallet">${address}</a></p>`,'https://plain.example');
  await page.locator('a').hover(); await page.getByRole('button',{name:'Edit wallet labels',exact:true}).click();
  for(let i=0;i<5;i++) await page.getByRole('button',{name:'Add label',exact:false}).click();
  await expect.poll(async()=>{
    const box=await page.getByRole('dialog').boundingBox();
    return box.y>=9 && box.y+box.height<=791;
  }).toBe(true);
});

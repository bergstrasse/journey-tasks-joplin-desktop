import test from 'node:test';
import { hostPanelStyle, hostPanelFragment } from '../fixtures/joplin-panel-host';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Optional real-renderer check. Set JOURNEY_BROWSER to a Chromium-family executable.
const browser = process.env.JOURNEY_BROWSER;
for (const size of ['320,568', '420,600', '900,600']) for (const baseline of [false, true]) {
  test(`${baseline ? '0.1.3 negative control' : 'fixed host wrappers'}: compiled panel scrolls long year content and restores background after drawer at ${size}`, { skip: !browser }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'journey-scroll-'));
    try {
      const snapshot = {
        snapshotVersion: 1, now: Date.now(), deviceZone: 'Asia/Shanghai', view: 'year',
        range: { start: '2026-01-01', end: '2027-01-01' },
        tasks: [], series: [], tags: [], folders: [{ id: 'book', title: '测试' }], diagnostics: [], warnings: [], truncated: false, loading: false,
        preferences: { startupMode: 'fixed', defaultView: 'year', lastView: 'year', language: 'zh-CN', showCompleted: false, overdueToday: true, overdueTomorrow: true, overdueSeven: true },
      };
      const css = readFileSync('dist/panel.css', 'utf8');
      const stylesheet = baseline ? css.replace(/,\s*#joplin-plugin-content-root/g, '').replace(/,\s*#joplin-plugin-content(?!-)/g, '').replace(/#root\s*\{([^}]*)\}/g, (_all, declarations) => '#root{' + declarations.replace(/flex:\s*1\s+1\s+0\s*;/, '') + '}') : css;
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${hostPanelStyle}</style><style>${stylesheet}</style></head><body>${hostPanelFragment}<script>
      const date = new Date().toLocaleDateString('en-CA');
      const tasks = Array.from({length:120}, (_,i) => ({taskId:'t'+i,noteId:'n'+i,title:'长列表任务'+i,notebookId:'book',tagIds:[],schedule:{kind:'allDay',date,zone:'Asia/Shanghai'},completedAt:0,priority:'none',pinned:false,reminder:{enabled:false}}));
      const snapshot = ${JSON.stringify(snapshot)};
      snapshot.tasks=tasks; snapshot.items=tasks.map(t=>({...t,id:t.taskId,date,kind:'actual',overdue:false,completed:false}));
      window.webviewApi={onMessage(){},postMessage:async m=>m.action==='snapshot'?{ok:true,snapshot:{...snapshot,view:m.query?.view||snapshot.view}}:{ok:true,result:{status:'saved'}}};
      </script><script>${readFileSync('dist/panel.js', 'utf8').replace(/<\/script/gi, '<\\/script')}</script><script>
      setTimeout(async()=>{
        const errors=[];const check=(ok,msg)=>{if(!ok)errors.push(msg)};
        const root=document.getElementById('root');
        check(document.querySelectorAll('.year-grid .calendar').length===12,'all twelve months rendered');
        check(root.clientHeight>0 && root.clientHeight<=innerHeight,'root bounded by viewport');
        check(root.scrollHeight>root.clientHeight,'content overflows root');
        check(getComputedStyle(root).overflowY==='auto','root scroll enabled');
        root.scrollTop=root.scrollHeight;
        check(root.scrollTop>0,'root scroll offset grows');
        const surface=document.querySelector('.view-surface');
        const grid=document.querySelector('.year-grid');
        const months=document.querySelectorAll('.year-grid>section');
        check(!!surface && !!grid,'year has a local scroll surface');
        if(surface && grid){
          check(getComputedStyle(surface).overflowX==='auto','year local horizontal scroll enabled');
          check(getComputedStyle(grid).gridTemplateColumns.split(' ').length===4,'year has four columns');
          if(surface.scrollWidth>surface.clientWidth){surface.scrollLeft=surface.scrollWidth;check(surface.scrollLeft>0,'year horizontal offset grows');}
          check(root.scrollWidth<=root.clientWidth+1,'horizontal overflow stays inside the local surface');
          root.scrollTop=root.scrollHeight;
          if(months.length){const rect=months[11].getBoundingClientRect(),bounds=surface.getBoundingClientRect();check(rect.top<innerHeight && rect.right<=bounds.right+1,'December reachable in both axes');}
        }
        document.querySelector('.mode-switch button').click();
        await new Promise(resolve=>setTimeout(resolve,150));
        // Repeated widening and shrinking must not leave the list at its old width.
        for(const width of [240,innerWidth,280,innerWidth]){
          document.documentElement.style.width=width+'px';
          const listSurface=document.querySelector('.view-surface');
          check(root.clientWidth<=width,'root shrinks with host width');
          check(listSurface.getBoundingClientRect().right<=root.getBoundingClientRect().right+1,'list scroll surface stays within host');
          listSurface.scrollLeft=0;
          const summary=document.querySelector('.day-group>summary');
          const toggle=summary.querySelector('.group-toggle svg');
          check(!!toggle,'group has a dedicated chevron');
          if(toggle){
            for(const open of [false,true]){
              summary.parentElement.open=open;
              const icon=toggle.getBoundingClientRect(),bounds=listSurface.getBoundingClientRect();
              check(icon.width>=17 && icon.height>=17 && icon.left>=bounds.left && icon.right<=bounds.right,'whole chevron visible in both states');
            }
            summary.click();check(!summary.parentElement.open,'group collapses');
            summary.click();check(summary.parentElement.open,'group expands');
          }
        }
        document.documentElement.style.width='';
        root.scrollTop=root.scrollHeight;
        const last=document.querySelector('.task-list .task-row:last-child');
        check(last && last.getBoundingClientRect().bottom<=innerHeight,'last task reachable');
        root.scrollTop=150;const before=root.scrollTop;
        document.querySelector('.header-actions .primary').click();
        setTimeout(()=>{
          const drawer=document.querySelector('.drawer');
          check(!!drawer,'drawer opens');check(getComputedStyle(root).overflowY==='hidden','background locked');
          if(drawer){check(drawer.scrollHeight>drawer.clientHeight,'drawer content overflows');drawer.scrollTop=drawer.scrollHeight;check(drawer.scrollTop>0,'drawer independently scrollable');}
          check(root.scrollTop===before,'background position preserved while opening');
          document.querySelector('.drawer-header button').click();
          setTimeout(()=>{check(getComputedStyle(root).overflowY==='auto','background unlocked');root.scrollTop=root.scrollHeight;check(root.scrollTop>before,'background scroll restored');const result=document.createElement('pre');result.id='scroll-result';result.textContent=JSON.stringify({errors,height:root.clientHeight,contentHeight:root.scrollHeight});document.body.append(result);},100);
        },100);
      },300);
      </script></body></html>`;
      const fixture = join(dir, 'scroll.html'); writeFileSync(fixture, html);
      const output = execFileSync(browser!, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(dir,'profile')}`, `--window-size=${size}`, '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(fixture).href], { encoding: 'utf8', timeout: 30000, stdio: ['ignore','pipe','pipe'] });
      const match = output.match(/<pre id="scroll-result">([^<]+)<\/pre>/);
      assert.ok(match, 'browser must finish layout checks');
      const result = JSON.parse(match[1]!);
      if (baseline) assert.ok(result.errors.includes('root bounded by viewport') || result.errors.includes('content overflows root') || result.errors.includes('root scroll offset grows'), 'legacy CSS must reproduce host-wrapper height failure');
      else assert.deepEqual(result.errors, [], JSON.stringify(result));
      console.log(size, JSON.stringify(result));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

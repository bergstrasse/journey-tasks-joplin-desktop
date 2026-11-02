import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostPanelStyle, hostPanelFragment } from '../fixtures/joplin-panel-host';

// Opt-in Chromium check against the compiled panel, with an isolated disposable profile.
const browser = process.env.JOURNEY_BROWSER;
for (const width of [320, 900]) for (const mode of ['date', 'year', 'time', 'task', 'settings', 'dark-settings', 'zh-settings', 'de-settings']) {
  test(`issue63 controls: ${mode} at ${width}px`, { skip: !browser }, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'journey-controls-'));
    try {
      const artifacts = resolve('.tmp/issue63'); mkdirSync(artifacts, { recursive: true });
      cpSync('dist/assets', join(temporary, 'assets'), { recursive: true });
      const snapshot = {
        snapshotVersion: 1, now: Date.now(), deviceZone: 'Asia/Shanghai', view: 'inbox',
        range: { start: '2026-10-01', end: '2026-11-01' }, items: [],
        tasks: [], series: [], tags: [], folders: [{ id: 'book', title: 'Tasks' }], diagnostics: [], warnings: [], truncated: false, loading: false,
        preferences: { startupMode: 'fixed', defaultView: 'inbox', lastView: 'inbox', language: mode.startsWith('zh-') ? 'zh-CN' : mode.startsWith('de-') ? 'de' : 'en', showCompleted: false, overdueToday: true, overdueTomorrow: true, overdueSeven: true },
      };
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${hostPanelStyle}</style><style>${readFileSync('dist/panel.css', 'utf8')}</style>${mode.startsWith('dark') ? '<style>:root{--joplin-background-color:#202124;--joplin-color:#e8eaed;--joplin-color-faded:#aeb4bd;--joplin-divider-color:#50545b;--joplin-color4:#8ab4f8;--joplin-color-correct:#357d38;--joplin-color-error:#f28b82}</style>' : ''}</head><body>${hostPanelFragment}<script>
      const snapshot = ${JSON.stringify(snapshot)};
      if(${JSON.stringify(mode)}==='task'){
        const task={taskId:'task',noteId:'note',title:'Example task',notebookId:'book',tagIds:[],schedule:{kind:'allDay',date:'2026-10-31',zone:'Asia/Shanghai'},completedAt:0,priority:'none',pinned:false,reminder:{enabled:true,allDayTime:'09:00'}};
        snapshot.tasks=[task];snapshot.items=[{...task,id:'note',date:'2026-10-31',kind:'actual',overdue:false,completed:false}];
      }
      window.webviewApi={onMessage(){},postMessage:async m=>m.action==='ready'||m.action==='snapshot'?{ok:true,snapshot}:{ok:true,result:{status:'saved'}}};
      </script><script>${readFileSync('dist/panel.js', 'utf8').replace(/<\/script/gi, '<\\/script')}</script><script>
      const pause=()=>new Promise(r=>setTimeout(r,60));
      setTimeout(async()=>{
        const errors=[];const check=(ok,msg)=>{if(!ok)errors.push(msg)};
        try {
          const mode=${JSON.stringify(mode)};
          if(mode.includes('settings')){
            document.querySelectorAll('.header-actions button')[1].click();await pause();
            const card=document.querySelector('.cleanup-settings');
            check(card.classList.contains('card'),'data management is a card');
            check(getComputedStyle(card).borderTopStyle==='solid','card has visible border');
            check(document.querySelectorAll('.settings-page a.button-link').length===2,'both external links styled as buttons');
            const sameType=nodes=>new Set([...nodes].map(node=>{const css=getComputedStyle(node);return [css.fontSize,css.fontWeight,css.lineHeight].join('/');})).size===1;
            const titles=document.querySelectorAll('.settings-page>.card .section-title');
            check(titles.length===3,'all three card headings use the same heading role');
            check(sameType(titles),'card headings have identical size weight and line height');
            check(sameType(document.querySelectorAll('.settings-page p.muted')),'all settings hints share typography');
            check(sameType(document.querySelectorAll('.settings-page button,.settings-page .button-link')),'settings actions share typography');
            const cards=[...document.querySelectorAll('.settings-page>.card')];
            for(let i=1;i<cards.length;i++)check(Math.abs(cards[i].getBoundingClientRect().top-cards[i-1].getBoundingClientRect().bottom-20)<1,'settings card gaps are consistent');
            for(const select of document.querySelectorAll('.settings-page select'))check(select.getBoundingClientRect().height===36,'settings fields share control height');
            for(const button of document.querySelectorAll('.settings-page button,.settings-page a.button-link')){
              const css=getComputedStyle(button);check(parseFloat(css.borderTopWidth)>=1,'action has visible border');check(css.boxShadow==='none','action has no shadow');
            }
          }else if(mode==='task'){
            document.querySelector('.task-content').click();await pause();
            const repeat=[...document.querySelectorAll('.drawer label.check')].find(label=>label.textContent.includes('Repeating task'));repeat.querySelector('input').click();await pause();
            document.querySelector('.date-time-trigger').click();await pause();
            const clear=[...document.querySelectorAll('.date-time-popover button')].find(button=>button.textContent==='Clear');
            check(!!clear,'required repeating date has Clear');
            if(clear){clear.click();await pause();const input=document.querySelector('.date-time-input input');check(input.value==='','required date clears');check(input.validity.valueMissing,'required date still validates');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2026-10-31');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();}
            const archive=[...document.querySelectorAll('.drawer select')].find(select=>[...select.options].some(option=>option.value==='archive'));archive.value='archive';archive.dispatchEvent(new Event('change',{bubbles:true}));await pause();
            const actions=document.querySelectorAll('.drawer form>button,.action-grid button,.weekday-picker button');
            check(new Set([...actions].map(node=>getComputedStyle(node).fontSize)).size===1,'task actions share text size');
            const original=document.querySelector('.action-grid button');
            if(original.textContent.endsWith('↗')){
              const text=original.firstChild,length=text.textContent.length;
              const last=document.createRange();last.setStart(text,length-1);last.setEnd(text,length);
              const word=document.createRange();word.setStart(text,length-3);word.setEnd(text,length-2);
              check(Math.abs(last.getBoundingClientRect().top-word.getBoundingClientRect().top)<1,'external marker does not wrap onto its own line');
            }
            const drawer=document.querySelector('.drawer');drawer.style.height='600px';drawer.scrollTop=200;await pause();
            check(drawer.scrollTop>0,'drawer scroll check exercises overflowing content');
            const close=drawer.querySelector('.drawer-header>button').getBoundingClientRect();
            check(close.top>=0&&close.bottom<=innerHeight,'sticky drawer close button stays fully visible');drawer.style.height='';drawer.scrollTop=0;
            for(const text of ['Weekdays','Weekends','Insert template block']){
              const button=[...document.querySelectorAll('.drawer button')].find(button=>button.textContent===text);
              check(!!button,text+' action present');if(button){const css=getComputedStyle(button);check(parseFloat(css.borderTopWidth)>=1,text+' has a visible border');check(css.boxShadow==='none',text+' has no shadow');}
            }
          }else{
            document.querySelector('.header-actions .primary').click();await pause();
            const triggers=document.querySelectorAll('.date-time-trigger');
            if(mode==='time')triggers[1].click();else{
              const input=document.querySelector('.date-time-input input');
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2026-10-31');input.dispatchEvent(new Event('input',{bubbles:true}));await pause();triggers[0].click();
            }
            await pause();
            const popover=document.querySelector('.date-time-popover');check(!!popover,'picker opens');
            check(popover.getBoundingClientRect().right<=innerWidth,'picker fits viewport');
            const controls=popover.querySelectorAll('.date-time-heading select,.year-select>button,.date-time-clock select,.date-time-clock>button,.date-time-popover>button');
            check(new Set([...controls].map(node=>getComputedStyle(node).fontSize)).size===1,'picker controls share text size');
            if(mode==='time'){
              const selects=[...popover.querySelectorAll('select')];const done=popover.querySelector('.date-time-clock>button');
              check(selects.length===2,'shared hour/minute controls');
              check(selects.every(s=>Math.abs(s.getBoundingClientRect().bottom-done.getBoundingClientRect().bottom)<1),'hour minute and done align');
              check([...popover.querySelectorAll('button')].some(b=>b.textContent==='Clear'),'clear available');
            }else{
              check(!popover.querySelector('[aria-label="Previous year"]'),'year shortcuts removed');
              check(popover.querySelectorAll('select[aria-label="Month"] option').length===12,'month dropdown available');
              check(popover.querySelector('.date-time-days .outside'),'adjacent month days filled');
              const selected=popover.querySelector('[aria-pressed=true]');check(selected&&parseFloat(getComputedStyle(selected).borderTopWidth)===2,'selection is outlined');
              const year=popover.querySelector('.year-select>button');year.click();await pause();
              const list=popover.querySelector('[role=listbox]');
              check(list.querySelectorAll('[role=option]').length===11,'only eleven years rendered');
              list.scrollTop=2497*32;list.dispatchEvent(new Event('scroll'));await pause();
              check(list.querySelectorAll('[role=option]').length===11,'scroll keeps eleven rendered years');
              const distant=[...list.querySelectorAll('[role=option]')].find(b=>b.textContent==='2500');check(!!distant,'distant year reachable');distant.click();await pause();
              check(year.textContent.includes('2500'),'distant year selected');
              year.click();await pause();const reset=popover.querySelector('[role=listbox]');reset.scrollTop=2023*32;reset.dispatchEvent(new Event('scroll'));await pause();
              [...reset.querySelectorAll('[role=option]')].find(b=>b.textContent==='2026').click();await pause();
              if(mode==='year'){year.click();await pause();}
              for(const button of popover.querySelectorAll('button'))check(getComputedStyle(button).boxShadow==='none','picker buttons have no shadows');
            }
          }
        }catch(error){errors.push(error.stack||String(error));}
        const measure=selector=>[...document.querySelectorAll(selector)].map(node=>{const css=getComputedStyle(node),rect=node.getBoundingClientRect();return {text:node.textContent.trim().slice(0,55),fontSize:css.fontSize,fontWeight:css.fontWeight,lineHeight:css.lineHeight,height:rect.height,padding:css.padding,borderRadius:css.borderRadius};});
        const typography={titles:measure('.settings-page>.card .section-title'),hints:measure('.settings-page p.muted'),actions:measure('.settings-page button,.settings-page .button-link,.drawer form>button,.action-grid button,.weekday-picker button'),picker:measure('.date-time-heading select,.year-select>button,.date-time-clock select,.date-time-clock>button,.date-time-popover>button')};
        const result=document.createElement('pre');result.id='controls-result';result.textContent=JSON.stringify({errors,typography});result.style.display='none';document.body.append(result);
      },200);
      </script></body></html>`;
      const fixture = join(temporary, 'controls.html'); writeFileSync(fixture, html);
      const output = execFileSync(browser!, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(temporary, 'profile')}`, `--window-size=${width},${mode.includes('settings') || mode === 'task' ? 1500 : 1000}`, '--virtual-time-budget=2500', `--screenshot=${join(artifacts, `${mode}-${width}.png`)}`, '--dump-dom', pathToFileURL(fixture).href], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
      const match = output.match(/<pre id="controls-result"[^>]*>([^<]+)<\/pre>/);
      assert.ok(match, 'browser must finish control checks');
      const report = JSON.parse(match[1]!); writeFileSync(join(artifacts, `${mode}-${width}.json`), JSON.stringify(report, null, 2)); assert.deepEqual(report.errors, []);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}

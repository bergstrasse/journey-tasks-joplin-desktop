import { useEffect, useRef, useState } from 'react';
import type { ViewKind } from '../shared/models';
import { useTranslation } from '../i18n/react';
import { Icon, type IconName } from './Icons';

const choices = ['day', 'week', 'month', 'year'] as const;
const icons: Record<typeof choices[number], IconName> = { day: 'today', week: 'week', month: 'calendar', year: 'year' };
export function CalendarViewPicker({ view, onChange }: { view: ViewKind; onChange: (view: ViewKind) => void }) {
  const { t } = useTranslation();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setPosition(undefined); trigger.current?.focus(); };
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setPosition(undefined); };
    const reposition = () => setPosition(undefined);
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) reposition(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', reposition);
    };
  }, [position]);
  return <div className="calendar-view-picker" ref={root}>
    <button className="calendar-view-select" ref={trigger} aria-label={t('mode.calendar')} aria-haspopup="menu" aria-expanded={!!position}
      onClick={() => {
        if (position) { close(); return; }
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ top: Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - 188)), left: Math.max(4, Math.min(rect.left, window.innerWidth - 132)) });
      }}><Icon name={icons[view as keyof typeof icons] ?? 'calendar'} /><span>{t(`view.${view}`)}</span><Icon name="chevronDown" size={14} /></button>
    {position && <div className="calendar-view-menu" ref={menu} role="menu" aria-label={t('mode.calendar')} style={position}
      onKeyDown={event => {
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if (event.key === 'Tab') setPosition(undefined);
      }}>{choices.map(choice => <button key={choice} role="menuitemradio" aria-checked={view === choice} tabIndex={view === choice ? 0 : -1}
        onClick={() => { onChange(choice); close(); }}><Icon name={icons[choice]} /><span>{t(`view.${choice}`)}</span><span className="view-check">{view === choice ? '✓' : ''}</span></button>)}</div>}
  </div>;
}

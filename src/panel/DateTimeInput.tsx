import React, { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icons';
import { useTranslation } from '../i18n/react';

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const YEAR_ROW_HEIGHT = 32;
const YEAR_VISIBLE_ROWS = 5;

function YearSelect({ year, label, onChange }: { year: number; label: string; onChange: (year: number) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState(1);
  const [active, setActive] = useState(year);
  const list = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLSpanElement>(null);
  const scrollToYear = (next: number) => {
    const top = Math.max(0, Math.min(9999 - YEAR_VISIBLE_ROWS, next - 3)) * YEAR_ROW_HEIGHT;
    setFirst(Math.max(1, Math.min(9989, Math.floor(top / YEAR_ROW_HEIGHT) - 2)));
    if (list.current) list.current.scrollTop = top;
  };
  useEffect(() => {
    if (!open) return;
    scrollToYear(year);
    list.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const choose = (next: number) => { onChange(next); setOpen(false); button.current?.focus(); };
  return <span className="year-select" ref={root}>
    <button type="button" ref={button} aria-label={label} aria-haspopup="listbox" aria-expanded={open}
      onClick={() => { setActive(year); setOpen(value => !value); }}>{year}<Icon name="chevronDown" size={16} /></button>
    {open && <span ref={list} className="year-options" role="listbox" aria-label={label} tabIndex={0}
      aria-activedescendant={active >= first && active < first + 11 ? `${id}-${active}` : undefined} onScroll={event => {
        setFirst(Math.max(1, Math.min(9989, Math.floor(event.currentTarget.scrollTop / YEAR_ROW_HEIGHT) - 2)));
      }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); }
        else {
          const next = event.key === 'ArrowDown' ? active + 1 : event.key === 'ArrowUp' ? active - 1
            : event.key === 'PageDown' ? active + 5 : event.key === 'PageUp' ? active - 5
            : event.key === 'Home' ? 1 : event.key === 'End' ? 9999 : undefined;
          if (next !== undefined) { event.preventDefault(); const bounded = Math.max(1, Math.min(9999, next)); setActive(bounded); scrollToYear(bounded); }
        }
      }}>
      <span className="year-options-track" style={{ height: 9999 * YEAR_ROW_HEIGHT }}>
        {Array.from({ length: 11 }, (_, i) => first + i).map(next => <button type="button" role="option"
          id={`${id}-${next}`} key={next} tabIndex={-1} aria-selected={year === next}
          className={active === next ? 'active' : undefined} style={{ top: (next - 1) * YEAR_ROW_HEIGHT }}
          onMouseEnter={() => setActive(next)} onClick={() => choose(next)}>{next}</button>)}
      </span>
    </span>}
  </span>;
}

/** Plugin-owned pickers avoid Chromium's host-locale UI and native focus handoffs. */
export function DateTimeInput({ type, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { type: 'date' | 'time' }) {
  const root = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { t, locale } = useTranslation();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const [month, setMonth] = useState('');
  const value = String(props.value ?? '');
  const close = () => { setPosition(undefined); trigger.current?.focus({ preventScroll: true }); };
  const updateValue = (next: string) => {
    // Use the input's native setter/event path so React consumers receive a real input event.
    const control = input.current;
    if (control) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, next);
      control.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  const choose = (next: string) => { updateValue(next); close(); };
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPosition(undefined);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [position]);
  useEffect(() => { setPosition(undefined); }, [props.disabled, props.readOnly, locale]);
  useEffect(() => {
    const valid = !value || (type === 'date'
      ? /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) > 0 && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
      : /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
    const inRange = (!props.min || value >= String(props.min)) && (!props.max || value <= String(props.max));
    input.current?.setCustomValidity?.(valid && (!value || inRange) ? '' : t(type === 'date' ? 'picker.invalidDate' : 'picker.invalidTime'));
  }, [value, type, props.min, props.max, t]);
  const base = month ? new Date(month + '-01T12:00:00Z') : new Date();
  const year = base.getUTCFullYear(), monthIndex = base.getUTCMonth();
  const end = new Date(base); end.setUTCMonth(monthIndex + 1, 0);
  const days = end.getUTCDate();
  const shift = (delta: number) => {
    const next = new Date(base); next.setUTCMonth(monthIndex + delta);
    if (next.getUTCFullYear() >= 1 && next.getUTCFullYear() <= 9999) setMonth(next.toISOString().slice(0, 7));
  };
  const label = t(type === 'date' ? 'menu.chooseDate' : 'field.time');
  return <span className="date-time-input" ref={root} onKeyDown={event => {
    if (position && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <input {...props} type="text" ref={input} placeholder={type === 'date' ? 'YYYY-MM-DD' : 'HH:mm'}
      pattern={type === 'date' ? '[0-9]{4}-[0-9]{2}-[0-9]{2}' : '[0-9]{2}:[0-9]{2}'} />
    <button type="button" ref={trigger} className="date-time-trigger" disabled={props.disabled || props.readOnly}
      aria-label={label} aria-haspopup="dialog" aria-expanded={!!position}
      onMouseDown={event => event.preventDefault()}
      onClick={event => {
        event.preventDefault(); event.stopPropagation();
        if (position) { close(); return; }
        const rect = trigger.current!.getBoundingClientRect();
        setMonth(/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value) ? value.slice(0, 7) : localToday().slice(0, 7));
        setPosition({ top: Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - 330)), left: Math.max(4, Math.min(rect.right - 280, window.innerWidth - 284)) });
      }}><Icon name={type === 'date' ? 'calendar' : 'clock'} /></button>
    {position && <span className="date-time-popover" role="dialog" aria-label={label} style={position}
      onClick={event => { event.stopPropagation(); }}>
      {type === 'date' ? <>
        <span className="date-time-heading">
          <button type="button" className="date-time-nav" aria-label={t('navigation.previousMonth')} disabled={year === 1 && monthIndex === 0} onClick={() => shift(-1)}><Icon name="back" size={18} /></button>
          <span className="picker-select month-select"><select aria-label={t('field.month')} value={monthIndex} onChange={event => {
            setMonth(`${String(year).padStart(4, '0')}-${String(Number(event.target.value) + 1).padStart(2, '0')}`);
          }}>{Array.from({ length: 12 }, (_, index) => {
            const date = new Date(base); date.setUTCMonth(index);
            return <option key={index} value={index}>{new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date)}</option>;
          })}</select><Icon name="chevronDown" size={16} /></span>
          <YearSelect year={year} label={t('field.year')} onChange={next => setMonth(`${String(next).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}`)} />
          <button type="button" className="date-time-nav" aria-label={t('navigation.nextMonth')} disabled={year === 9999 && monthIndex === 11} onClick={() => shift(1)}><Icon name="chevronRight" size={18} /></button>
        </span>
        <span className="date-time-days">{[7, 1, 2, 3, 4, 5, 6].map(day => <span key={'w' + day}>{t(`weekday.${day}`)}</span>)}
          {Array.from({ length: Math.ceil((base.getUTCDay() + days) / 7) * 7 }, (_, i) => {
            const cell = new Date(base); cell.setUTCDate(1 - base.getUTCDay() + i);
            const date = cell.toISOString().slice(0, 10);
            const outside = cell.getUTCMonth() !== monthIndex;
            return <button key={date} type="button" aria-label={date} aria-pressed={value === date} className={outside ? 'outside' : undefined}
              disabled={cell.getUTCFullYear() < 1 || cell.getUTCFullYear() > 9999 || !!(props.min && date < String(props.min) || props.max && date > String(props.max))} onClick={() => choose(date)}>{cell.getUTCDate()}</button>;
          })}</span>
        <button type="button" disabled={!!(props.min && localToday() < String(props.min) || props.max && localToday() > String(props.max))} onClick={() => choose(localToday())}>{t('view.today')}</button>
      </> : <span className="date-time-clock">
        <label>{t('picker.hour')}<span className="picker-select"><select value={value.slice(0, 2) || '09'} onChange={event => {
          updateValue(`${event.target.value}:${value.slice(3, 5) || '00'}`);
        }}>{Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map(hour => <option key={hour}>{hour}</option>)}</select><Icon name="chevronDown" size={16} /></span></label>
        <label>{t('picker.minute')}<span className="picker-select"><select value={value.slice(3, 5) || '00'} onChange={event => {
          updateValue(`${value.slice(0, 2) || '09'}:${event.target.value}`);
        }}>{Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')).map(minute => <option key={minute}>{minute}</option>)}</select><Icon name="chevronDown" size={16} /></span></label>
        <button type="button" onClick={() => choose(value || '09:00')}>{t('picker.done')}</button>
      </span>}
      <button type="button" onClick={() => choose('')}>{t('picker.clear')}</button>
    </span>}
  </span>;
}

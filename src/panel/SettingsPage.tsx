import { REPORT_ISSUE_URL, SUPPORT_AUTHOR_URL } from '../shared/externalLinks';
import { reportIssue, supportAuthor } from './client';
import React, { useState } from 'react';
import manifest from '../manifest.json';
import { defaultPreferences, type ViewPreferences } from '../adapters/joplin/localIntentStore';
import type { ViewKind } from '../shared/models';
import { registry } from '../i18n';
import { useTranslation } from '../i18n/react';
import { CleanupSettings } from './CleanupSettings';
import { Icon } from './Icons';

type SettingsDraft = Pick<ViewPreferences, 'language' | 'startupMode' | 'defaultView' | 'defaultCalendar' | 'timeFormat'>;
export function SettingsPage({ preferences, busy, error, errorCode, onSave, onCancel, onCommand, onCleared }: {
  preferences: ViewPreferences; busy: boolean; error?: string; errorCode?: string;
  onSave: (patch: SettingsDraft) => Promise<unknown>; onCancel: () => void;
  onCommand: React.ComponentProps<typeof CleanupSettings>['onCommand']; onCleared: () => void;
}) {
  const { t, message } = useTranslation();
  const draftFrom = (value: ViewPreferences): SettingsDraft => ({ language: value.language, startupMode: value.startupMode,
    defaultView: value.defaultView, defaultCalendar: value.defaultCalendar ?? 'solar', timeFormat: value.timeFormat ?? '24h' });
  const [linkError, setLinkError] = useState<string>();
  const [draft, setDraft] = useState(() => draftFrom(preferences));
  const views: ViewKind[] = ['today', 'tomorrow', 'sevenDays', 'inbox', 'all', 'day', 'week', 'month', 'year'];
  return <section className="settings-page">
    <header className="settings-header"><h1>{t('settings.title')}</h1><button disabled={busy} onClick={onCancel}>{t('actions.cancel')}</button></header>
    <section className="settings-about card" aria-label="Journey Tasks">
      <div><h2 className="section-title">Journey Tasks</h2><span className="muted">{t('settings.version')} {manifest.version}</span></div>
      <a className="button-link" href={REPORT_ISSUE_URL} onClick={async event => {
        event.preventDefault();
        setLinkError(undefined);
        try { await reportIssue(); } catch (error) { setLinkError((error as Error).message); }
      }}><Icon name="feedback" size={18} />{t('settings.reportIssue')}</a>
    </section>
    {linkError && <p className="error" role="alert">{message(linkError)}</p>}
    {error && <p className="error" role="alert">{message(error, errorCode)}</p>}
    <form className="settings card" onSubmit={event => { event.preventDefault(); if (!busy) void onSave(draft); }}>
      <label>{t('settings.language')}<select disabled={busy} value={draft.language} onChange={e => setDraft({ ...draft, language: e.target.value as ViewPreferences['language'] })}><option value="auto">{t('settings.auto')}</option>{Object.values(registry).map(entry => <option key={entry.id} value={entry.id}>{entry.nativeName}</option>)}</select></label>
      <p className="muted">{t('settings.languageHint')}</p>
      <label>{t('settings.startup')}<select disabled={busy} value={draft.startupMode} onChange={e => setDraft({ ...draft, startupMode: e.target.value as ViewPreferences['startupMode'] })}><option value="fixed">{t('settings.fixed')}</option><option value="restore">{t('settings.restore')}</option></select></label>
      <label>{t('settings.defaultView')}<select disabled={busy} value={draft.defaultView} onChange={e => setDraft({ ...draft, defaultView: e.target.value as ViewKind })}>{views.map(view => <option key={view} value={view}>{t(`view.${view}`)}</option>)}</select></label>
      <label>{t('settings.defaultCalendar')}<select disabled={busy} value={draft.defaultCalendar} onChange={e => setDraft({ ...draft, defaultCalendar: e.target.value as 'solar' | 'lunar' })}><option value="solar">{t('rule.gregorian')}</option><option value="lunar">{t('rule.lunar')}</option></select></label>
      <label>{t('settings.timeFormat')}<select disabled={busy} value={draft.timeFormat} onChange={e => setDraft({ ...draft, timeFormat: e.target.value as ViewPreferences['timeFormat'] })}><option value="24h">{t('settings.time24')}</option><option value="12h">{t('settings.time12')}</option></select></label>
      <p className="muted">{t('settings.note')}</p>
      <button className="primary" type="submit" disabled={busy}>{t('actions.save')}</button>
    </form>
    <CleanupSettings busy={busy} error={error} errorCode={errorCode} onCommand={onCommand} onCleared={() => { setDraft(draftFrom(defaultPreferences)); onCleared(); }} />
    <section className="settings-support card" aria-labelledby="settings-support-title">
      <h2 className="section-title" id="settings-support-title">{t('settings.supportAuthor')}</h2>
      <div className="settings-support-content">
        <a className="button-link" href={SUPPORT_AUTHOR_URL} onClick={async event => {
          event.preventDefault();
          setLinkError(undefined);
          try { await supportAuthor(); } catch (error) { setLinkError((error as Error).message); }
        }}><Icon name="coffee" size={18} />Buy me a coffee</a>
        <p className="muted">{t('settings.supportHint')}</p>
        <div className="settings-support-qr" role="img" aria-label={t('settings.supportQr')} />
      </div>
    </section>
  </section>;
}

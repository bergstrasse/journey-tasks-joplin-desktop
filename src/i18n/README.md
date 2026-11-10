# Interface localization

[简体中文](README.zh-CN.md)

The interface uses independent JSON dictionaries. There are currently 26 language/region options; `registry.ts` is the source of truth. The language preference is stored per device and accepts `auto` or a registered locale ID. In automatic mode, the plugin reads the Joplin locale once at startup, using `settings.globalValues` and falling back to the legacy `settings.globalValue` API if that call fails. If the host locale is unavailable or empty, it uses US English (`en-US`). Restart the plugin after changing the Joplin language; the host locale is not polled.

## Updating an existing translation

For German, edit `locales/de.json`. Other languages have their own files under `locales/`. Compare against `locales/en.json` or `locales/zh-CN.json`, which use the same flat semantic keys.

- Translate values only; keep keys such as `actions.refresh` unchanged.
- Preserve named parameters such as `{title}` and `{count}`, including their names. Missing parameters remain visible; inserted values are not translated or expanded again.
- Preserve literal template markers such as `<!-- template:start -->` and `<!-- template:end -->` wherever present.
- Keep every key and provide a nonempty value. A missing translation falls back to Simplified Chinese; a key missing from both dictionaries is returned unchanged. These fallbacks do not count as a completed translation.

Additional languages were initially machine translated. Automated checks verify structure, parameters and template markers, but do not guarantee linguistic quality; human corrections are welcome. All dictionaries are bundled for offline use, with no runtime translation service.

## Adding a language

1. Copy `locales/en.json` to `locales/xx.json` and translate the values using the rules above.
2. Import and register the dictionary in `registry.ts` with a unique locale ID and a native language name:

   ```ts
   import example from './locales/xx.json';

   // Add inside the registry object:
   xx: { id: 'xx', nativeName: 'Language name', dictionary: example },
   ```

3. Language choices and preference validation follow the registry automatically; the task model and storage validation need no changes. Review `resolveLanguage` for regional/script matching and `languageDirection` if adding a right-to-left language. Currently only Persian (`fa`) uses RTL.
4. Update assertions that explicitly expect 26 locales in `tests/unit/i18n.test.ts` and `tests/package-smoke.test.ts` when changing the locale count. Review the count in both versions of this README as well.

## Runtime behavior

`resolveLanguage(preference, locales)` accepts a locale string or an ordered list. An explicit registered preference wins. Automatic matching normalizes underscores and case, then tries an exact registered ID followed by its language family for each candidate. Chinese script subtags take precedence over region: `Hant` selects Traditional Chinese, while `Hans` selects Simplified Chinese; without a script, `TW`, `HK` and `MO` select Traditional Chinese. Bare Romanian defaults to `ro-RO`. If no candidate matches, resolution falls back to `en-US`. When called without locale hints, the helper uses browser language preferences or the runtime Intl locale.

`createTranslator(locale)` returns the React-independent function `t(key, params?)`. An unregistered locale selects the `en-US` dictionary. `TranslationProvider` and `useTranslation` live in `react.tsx` and use the bundled React instance. Components without a provider default to Simplified Chinese. Saving a language preference updates the panel immediately; host-registered menu labels update on the next plugin startup.

Language changes affect interface text, not user titles, note bodies, notebook names, templates, schedules, time zones or recurrence rules. User content is passed as interpolation data rather than looked up as translation keys. Undated tasks remain undated. Internal calendar date values use ISO dates; displayed dates also depend on the selected calendar and locale. Time display uses Intl with the locale and the independent 12/24-hour preference.

`translateMessage` localizes known error codes and exact known Chinese/English diagnostic messages. Unknown messages are preserved. Use it only for error/diagnostic channels, never for user content; it does not scan the DOM. Keep error messages in the locale dictionaries rather than scattering translation tables across components.

## Validation and bundle size

Run from the repository root:

```sh
npm run typecheck
node --import tsx --test tests/unit/i18n.test.ts tests/unit/translation-usage.test.ts tests/integration/language.test.ts tests/integration/host-language.test.ts tests/integration/panel-language.test.ts
npm run build
npm run verify:package
```

The language tests check dictionary keys, nonempty values, named parameters, template markers, locale resolution, persistence and rendering. Also review translations in the panel, especially narrow layouts, confirmation dialogs and RTL layouts where applicable.

Source JSON files remain the sole translation source. The panel build shares dictionary keys and compresses repeated text, then reconstructs complete dictionaries at runtime, allowing all registered languages to switch offline. The host build first inspects its dependency graph and retains only dictionary keys referenced as complete string literals in host business code, including commands, notices and default titles. Use complete literal keys for new host translation calls; dynamically constructed keys are not retained automatically. The complete panel dictionaries do not enter the host bundle.

The support QR code is a separate PNG referenced by a relative CSS URL and included in the JPL automatically. Build logs and `publish/build-metadata.json` report artifact sizes. Package smoke tests check archive contents, dictionary equivalence before/after bundling for all 26 locales and the host subset, and a maximum JPL size of 1,500,000 bytes. Adding translations may require checking the bundle size budget.
